import fs from 'fs';
import path from 'path';
import { DialogueSegment, JobSettings } from '../types.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';

export class AudioMixingService {
  /**
   * Assembles all individual dialogue audio segments onto a single master
   * dialogue track, each line placed at its own timestamp (`adelay`) and the
   * whole track padded to the video's length (`apad`), so every line starts
   * where it was spoken and the master track never comes up short.
   *
   * Lines are deliberately **not** cut to their original slot any more. Trimming
   * a Khmer line down to the length of the English one is the "make the audio
   * match the video" step the owner asked to remove — it sliced long sentences
   * mid-syllable. A line that runs past its slot now simply plays out; `amix`
   * handles any overlap and the render still caps the file at the video's own
   * length.
   */
  public static async assembleDialogueTrack(
    segments: DialogueSegment[],
    totalDuration: number,
    outputSpeechTrackPath: string
  ): Promise<string> {
    const raw = segments.filter(s => s.audioFile && fs.existsSync(s.audioFile));
    // Mouth order is timeline order; WHISPER can return out-of-order chunks
    const validSegments = [...raw].sort((a, b) => a.start - b.start);

    if (validSegments.length === 0) {
      logger.warn('No valid audio segments to assemble; generating silent audio track');
      await FFmpegHelper.execute([
        '-y',
        '-f', 'lavfi',
        '-i', `anullsrc=r=44100:cl=stereo`,
        '-t', totalDuration.toString(),
        '-acodec', 'pcm_s16le',
        outputSpeechTrackPath,
      ]);
      return outputSpeechTrackPath;
    }

    const inputArgs: string[] = [];
    const filterClauses: string[] = [];
    const mixInputs: string[] = [];

    validSegments.forEach((seg, idx) => {
      inputArgs.push('-i', seg.audioFile!);
      const delayMs = Math.max(0, Math.round(seg.start * 1000));
      filterClauses.push(`[${idx}:a]adelay=${delayMs}|${delayMs}[a${idx}]`);
      mixInputs.push(`[a${idx}]`);
    });

    filterClauses.push(
      `${mixInputs.join('')}amix=inputs=${validSegments.length}:dropout_transition=0:normalize=0,apad=whole_dur=${Math.ceil(totalDuration)}[out]`
    );

    await FFmpegHelper.execute([
      '-y',
      ...inputArgs,
      '-filter_complex', filterClauses.join(';'),
      '-map', '[out]',
      '-ac', '2',
      '-ar', '44100',
      outputSpeechTrackPath,
    ]);

    logger.info(
      `Assembled ${validSegments.length} dialogue segment(s), each placed at its own timestamp, into master track: ${outputSpeechTrackPath}`
    );
    return outputSpeechTrackPath;
  }

  /**
   * Sync pass: pull a translated line back inside the slot it was spoken in.
   *
   * gTTS speaks the translation at its own pace, so a Khmer line is regularly
   * longer than the English one it replaces. Placing every line at its own start
   * time keeps the *entries* right, but a line that runs into the next one is
   * heard over it. This pass shortens only the lines that would overlap, and only
   * by speeding them up (`atempo`, which preserves pitch) up to
   * `DUB_SYNC_MAX_TEMPO` (1.75 by default). Nothing is cut — every word is still
   * spoken — and a line that even the cap cannot fit is left to play out exactly
   * as before. `DUB_SYNC_ENABLED=false` turns the pass off.
   *
   * A small overrun (under 8%) is left alone: it lands in the pause before the
   * next line, so stretching it would only make the voice sound rushed for no
   * audible gain.
   */
  public static async fitDialogueToSlots(
    segments: DialogueSegment[],
    options: { maxTempo?: number; tolerance?: number } = {}
  ): Promise<DialogueSegment[]> {
    if (process.env.DUB_SYNC_ENABLED === 'false') return segments;

    const configuredMax = Number(process.env.DUB_SYNC_MAX_TEMPO);
    const maxTempo = Math.min(
      2,
      Math.max(1.05, options.maxTempo ?? (Number.isFinite(configuredMax) ? configuredMax : 1.75))
    );
    const tolerance = Math.max(1, options.tolerance ?? 1.08);

    // The timeline is what the dub is measured against, so the next line is the
    // next *spoken* timestamp — a line whose voice failed has no audio to overlap.
    const voiced = segments
      .filter((seg) => seg.audioFile && fs.existsSync(seg.audioFile) && (seg.audioDuration ?? 0) > 0)
      .sort((a, b) => a.start - b.start);
    if (voiced.length < 2) return segments;

    let fitted = 0;
    for (let i = 0; i < voiced.length - 1; i++) {
      const seg = voiced[i];
      const next = voiced[i + 1];
      const slot = next.start - seg.start;
      const duration = seg.audioDuration ?? 0;
      if (slot <= 0.2 || duration <= 0) continue;

      const ratio = duration / slot;
      if (ratio <= tolerance) continue;

      const tempo = Math.min(maxTempo, ratio);
      if (tempo <= tolerance) continue;

      const fittedPath = path.join(
        path.dirname(seg.audioFile!),
        `${path.basename(seg.audioFile!, path.extname(seg.audioFile!))}_sync.wav`
      );

      try {
        await FFmpegHelper.execute([
          '-y',
          '-i', seg.audioFile!,
          '-filter:a', `atempo=${tempo.toFixed(3)}`,
          '-ar', '44100',
          '-ac', '2',
          fittedPath,
        ]);
        const newDuration = await FFmpegHelper.getAudioDuration(fittedPath);
        if (!(newDuration > 0)) continue;

        try {
          fs.unlinkSync(seg.audioFile!);
        } catch {}
        seg.audioFile = fittedPath;
        seg.audioDuration = newDuration;
        fitted++;
      } catch (err: any) {
        // The original line is still intact; only the fit failed.
        logger.warn(`Could not stretch ${seg.id} into its slot: ${err?.message ?? err}`);
      }
    }

    if (fitted > 0) {
      logger.info(
        `Sync: pulled ${fitted} dubbed line(s) back into their spoken slot (max tempo ${maxTempo}x).`
      );
    }
    return segments;
  }

  /**
   * Mixes the dubbed Khmer dialogue track with the background music/ambient audio
   * (no_vocals.wav).
   *
   * `segments` supplies the dialogue windows: when the background still carries
   * the original voices (a mono source that could not be separated), the
   * background is ducked inside them so the old dialogue cannot be heard under
   * the Khmer dub. With real stem separation the background is already
   * voice-free, so a plain volume balance is used instead. Windows are sorted and
   * merged so the ducking expression stays short and never flickers on
   * overlapping timestamps.
   */
  public static async mixDubbedWithBackground(
    speechTrackPath: string,
    backgroundTrackPath: string,
    outputMixedTrackPath: string,
    settings: JobSettings,
    options: {
      segments?: DialogueSegment[];
      backgroundHasOriginalVoice?: boolean;
      /** Reported while the mix is written, so a slow host still shows movement. */
      onProgress?: (writtenSeconds: number) => void;
    } = {}
  ): Promise<string> {
    const source = (options.segments || [])
      .filter(
        (segment) =>
          Number.isFinite(segment.start) &&
          Number.isFinite(segment.end) &&
          segment.end > segment.start
      )
      .map((segment) => ({ start: segment.start, end: segment.end }));

    const raw = [...source].sort((a, b) => a.start - b.start);

    // Merge overlapping / nearly-touching windows so the gate doesn't chatter
    const dialogueWindows: { start: number; end: number }[] = [];
    for (const w of raw) {
      const last = dialogueWindows[dialogueWindows.length - 1];
      if (last && w.start <= last.end + 0.08) {
        last.end = Math.max(last.end, w.end);
      } else {
        dialogueWindows.push({ ...w });
      }
    }

    return await FFmpegHelper.mixDubbedAudio(
      speechTrackPath,
      backgroundTrackPath,
      outputMixedTrackPath,
      {
        backgroundMusic: settings.backgroundMusic,
        speechVolume: 1.3,
        musicVolume: settings.backgroundMusic === 'reduce' ? 0.35 : 0.65,
        dialogueWindows,
        backgroundHasOriginalVoice: options.backgroundHasOriginalVoice ?? false,
        onProgress: options.onProgress,
      }
    );
  }
}
