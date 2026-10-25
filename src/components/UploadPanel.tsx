import React, { useRef, useState } from 'react';
import { Upload, FileVideo, CheckCircle2, AlertCircle, Sparkles, Music2, MicOff, ArrowRight } from 'lucide-react';
import { JobSettings } from '../types';

interface UploadPanelProps {
  onFileSelect: (file: File) => void;
  selectedFile: File | null;
  videoPreviewUrl: string | null;
  videoDuration: number | null;
  videoResolution: { width: number; height: number } | null;
  settings: JobSettings;
  onStartDubbing: () => void;
  isUploading: boolean;
  uploadProgress: number;
  /**
   * No Demucs service is connected. Stem separation is required, so the server
   * refuses the upload — holding the button back here means the studio says why
   * before a video is picked, instead of after one has been uploaded.
   */
  startBlocked?: boolean;
}

export const UploadPanel: React.FC<UploadPanelProps> = ({
  onFileSelect,
  selectedFile,
  videoPreviewUrl,
  videoDuration,
  videoResolution,
  onStartDubbing,
  isUploading,
  uploadProgress,
  startBlocked = false,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/i.test(file.name)) {
        onFileSelect(file);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileSelect(e.target.files[0]);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDuration = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remSecs = Math.floor(secs % 60);
    return `${mins}:${remSecs < 10 ? '0' : ''}${remSecs}`;
  };

  return (
    <div className="space-y-6">
      {/* Upload Zone / Drop area */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !isUploading && fileInputRef.current?.click()}
        className={`relative overflow-hidden rounded-2xl border-2 border-dashed p-5 sm:p-10 text-center transition-all cursor-pointer select-none ${
          isDragOver
            ? 'border-emerald-400 bg-emerald-500/10 scale-[1.01]'
            : 'border-slate-700/80 bg-[#111827]/60 hover:border-emerald-500/50 hover:bg-[#111827]/90'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/*"
          onChange={handleFileChange}
          className="hidden"
          disabled={isUploading}
        />

        <div className="max-w-md mx-auto space-y-4">
          <div className="w-14 h-14 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-tr from-emerald-600/30 to-teal-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center mx-auto shadow-inner">
            <Upload className="w-8 h-8 sm:w-10 sm:h-10 animate-bounce" />
          </div>

          <div>
            <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">
              {selectedFile ? 'ប្តូរវីដេអូថ្មី (Change Video)' : 'បញ្ចូលវីដេអូ (Upload Video)'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1.5 leading-relaxed">
              អូសនិងទម្លាក់វីដេអូ ឬចុចដើម្បីជ្រើសរើសពីទូរស័ព្ទ/កុំព្យូទ័រ
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              គាំទ្រ: MP4, MOV, WEBM • Maximum video size: 500 MB
            </p>
          </div>

          {/* Android Friendly Button */}
          <div className="pt-2">
            <button
              type="button"
              disabled={isUploading}
              className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-semibold text-sm shadow-lg shadow-emerald-600/25 active:scale-95 transition-all min-h-[48px] w-full sm:w-auto"
            >
              <Upload className="w-4 h-4" />
              <span>ជ្រើសរើសវីដេអូ (Select Video)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Selected Video Metadata Preview Card */}
      {selectedFile && (
        <div className="p-4 sm:p-5 rounded-2xl bg-[#111827]/90 border border-emerald-500/30 shadow-lg space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3.5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                <FileVideo className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-white truncate max-w-xs sm:max-w-md">
                  {selectedFile.name}
                </h4>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300 mt-0.5">
                  <span className="font-medium text-emerald-400">{formatFileSize(selectedFile.size)}</span>
                  {videoDuration && (
                    <>
                      <span>•</span>
                      <span>ថិរវេលា: {formatDuration(videoDuration)}</span>
                    </>
                  )}
                  {videoResolution && (
                    <>
                      <span>•</span>
                      <span>កម្រិត: {videoResolution.width}x{videoResolution.height}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="w-full sm:w-auto space-y-2">
              <button
                type="button"
                onClick={onStartDubbing}
                disabled={isUploading || startBlocked}
                title={startBlocked ? 'ត្រូវភ្ជាប់ Demucs API សិន (Demucs is required first)' : undefined}
                className="w-full px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-bold text-sm shadow-lg shadow-emerald-500/20 active:scale-95 transition-all flex items-center justify-center gap-2 min-h-[48px] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <Sparkles className="w-4 h-4" />
                <span>{isUploading ? 'កំពុងផ្ទុកឡើង...' : 'ចាប់ផ្តើមបញ្ចូលសំឡេង (Start Dubbing)'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              {startBlocked && (
                <p className="text-[11px] text-amber-300 text-center sm:text-left">
                  ត្រូវភ្ជាប់ Demucs API សិន — បើគ្មានវា ការបញ្ចូលសំឡេងមិនដំណើរការទេ។
                </p>
              )}
            </div>
          </div>

          {/* Upload Progress Bar if active */}
          {isUploading && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-semibold text-slate-300">
                <span>កំពុងផ្ទុកវីដេអូឡើងទៅកាន់ម៉ាស៊ីនបម្រើ...</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300 rounded-full"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Video Preview Tag */}
          {videoPreviewUrl && (
            <div className="rounded-xl overflow-hidden bg-black/60 border border-slate-800/80 max-h-64 flex justify-center items-center">
              <video
                src={videoPreviewUrl}
                controls
                className="max-h-64 w-auto object-contain rounded-lg"
              />
            </div>
          )}
        </div>
      )}

      {/* Target Processing Architecture Visualizer */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Audio Separation Target */}
        <div className="p-4 rounded-xl bg-[#111827]/60 border border-slate-800 space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
            <MicOff className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>ការបំបែកសំឡេងឆ្លាតវៃ (Intelligent Separation)</span>
          </div>
          <div className="text-xs text-slate-300 space-y-1.5 font-mono bg-slate-950/60 p-3 rounded-lg border border-slate-800/60">
            <div className="text-slate-400 font-sans font-semibold">ORIGINAL AUDIO:</div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-rose-400">
              <span className="min-w-0">├── សំឡេងមនុស្ស (Human Speech)</span>
              <span className="text-[10px] leading-5 px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 whitespace-nowrap">REMOVE</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-emerald-400">
              <span className="min-w-0">├── ភ្លេងប្រគុំ (Music Track)</span>
              <span className="text-[10px] leading-5 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 whitespace-nowrap">KEEP 100%</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-teal-400">
              <span className="min-w-0">├── សំឡេងបរិយាកាស (Ambience)</span>
              <span className="text-[10px] leading-5 px-1.5 py-0.5 rounded bg-teal-500/20 text-teal-300 whitespace-nowrap">KEEP</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-cyan-400">
              <span className="min-w-0">└── សំឡេង Effect (SFX)</span>
              <span className="text-[10px] leading-5 px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 whitespace-nowrap">KEEP</span>
            </div>
          </div>
        </div>

        {/* Translation & Voice Target */}
        <div className="p-4 rounded-xl bg-[#111827]/60 border border-slate-800 space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
            <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>សំឡេងខ្មែរ AI ធម្មជាតិ (Natural Spoken Khmer)</span>
          </div>
          <div className="text-xs text-slate-300 space-y-2 bg-slate-950/60 p-3 rounded-lg border border-slate-800/60">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>បកប្រែជាភាសាខ្មែរនិយាយបែបធម្មជាតិ ដោយរក្សាបរិបទតួអង្គ</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>កំណត់អ្នកនិយាយ និងសំឡេងតួអង្គប្រុស/ស្រីដោយស្វ័យប្រវត្តិ</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>តម្រឹមចង្វាក់សំឡេងឱ្យត្រូវតាមពេលវេលាដើម</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>បញ្ចូលសំឡេងជាមួយភ្លេងដើមដោយសម្រួលកម្រិតស្វ័យប្រវត្តិ (Ducking)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
