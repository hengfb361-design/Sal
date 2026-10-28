#!/data/data/com.termux/files/usr/bin/bash
# ---------------------------------------------------------------
# DVWA (Damn Vulnerable Web Application) for Termux
# A deliberately insecure app for practising web security on
# YOUR OWN device. It only listens on 127.0.0.1 by default.
#
#   bash dvwa-termux.sh install   # install / update everything
#   bash dvwa-termux.sh start     # start MariaDB + Apache
#   bash dvwa-termux.sh stop      # stop both
#   bash dvwa-termux.sh status    # what is running
#   bash dvwa-termux.sh url       # print the lab URL
# ---------------------------------------------------------------

set -uo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
DVWA_HOME="$HOME/dvwa"
DB_NAME="dvwa"
DB_USER="dvwa"
DB_PASS="p@ssw0rd"
HOST="127.0.0.1"
PORT="8080"
LAB_URL="http://$HOST:$PORT/dvwa"

c_ok=$'\033[1;32m'; c_info=$'\033[1;36m'; c_warn=$'\033[1;33m'; c_err=$'\033[1;31m'; c_off=$'\033[0m'
info() { printf '\n%s==> %s%s\n' "$c_info" "$*" "$c_off"; }
ok()   { printf '%s[+] %s%s\n' "$c_ok" "$*" "$c_off"; }
warn() { printf '%s[!] %s%s\n' "$c_warn" "$*" "$c_off"; }
die()  { printf '%s[x] %s%s\n' "$c_err" "$*" "$c_off" >&2; exit 1; }

need_termux() {
    [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ] \
        || die "This script is for Termux on Android (no Docker needed there)."
}

mysql_running() {
    mariadb-admin -u root ping >/dev/null 2>&1
}

apache_running() {
    (exec 3<>"/dev/tcp/$HOST/$PORT") >/dev/null 2>&1
}

start_mysql() {
    if mysql_running; then ok "MariaDB already running"; return 0; fi
    info "Starting MariaDB"
    if [ ! -d "$PREFIX/var/lib/mysql/mysql" ]; then
        warn "Data directory missing, initialising it"
        mkdir -p "$PREFIX/var/lib/mysql"
        mariadb-install-db --user=root --auth-root-authentication-method=normal \
            --datadir="$PREFIX/var/lib/mysql" >/dev/null 2>&1 \
            || die "mariadb-install-db failed"
    fi
    mkdir -p "$PREFIX/var/log"
    if command -v mysqld_safe >/dev/null 2>&1; then
        nohup mysqld_safe --datadir="$PREFIX/var/lib/mysql" \
            >"$PREFIX/var/log/mysqld.out" 2>&1 &
    else
        nohup mysqld --basedir="$PREFIX" --datadir="$PREFIX/var/lib/mysql" \
            >"$PREFIX/var/log/mysqld.out" 2>&1 &
    fi
    local i
    for i in $(seq 1 40); do
        mysql_running && { ok "MariaDB is up"; return 0; }
        sleep 0.5
    done
    die "MariaDB did not come up — see $PREFIX/var/log/mysqld.out"
}

stop_mysql() {
    if mysql_running; then
        mariadb-admin -u root shutdown >/dev/null 2>&1 && ok "MariaDB stopped"
    else
        ok "MariaDB was not running"
    fi
}

configure_mpm() {
    # Termux's Apache defaults to the threaded 'event' MPM, but PHP's module is
    # built non-threadsafe (non-ZTS). Mixing them aborts startup with
    # "Apache is running a threaded MPM, but your PHP Module is not compiled to be
    # threadsafe" — so switch Apache to the prefork MPM.
    local conf="$PREFIX/etc/apache2/httpd.conf"
    MPM_CHANGED=0
    [ -f "$conf" ] || return 0
    local modpath
    modpath=$(grep -oE '^[[:space:]]*LoadModule[[:space:]]+mpm_prefork_module[[:space:]]+[^[:space:]]+' "$conf" | awk '{print $3}' | head -1)
    [ -n "$modpath" ] || modpath=$(grep -oE '^[[:space:]]*LoadModule[[:space:]]+mpm_(event|worker)_module[[:space:]]+[^[:space:]]+' "$conf" | awk '{print $3}' | head -1 | sed -E 's/mpm_(event|worker)/mpm_prefork/')
    [ -n "$modpath" ] || modpath="libexec/apache2/mod_mpm_prefork.so"
    if [ ! -e "$modpath" ] && [ ! -e "$PREFIX/$modpath" ]; then
        warn "mod_mpm_prefork.so not found — cannot switch Apache to the prefork MPM"
        return 1
    fi
    if grep -qE '^[[:space:]]*LoadModule[[:space:]]+mpm_(event|worker)_module' "$conf"; then
        sed -i -E 's@^([[:space:]]*LoadModule[[:space:]]+mpm_(event|worker)_module.*)$@# \1@' "$conf"
        MPM_CHANGED=1
    fi
    if ! grep -qE '^[[:space:]]*LoadModule[[:space:]]+mpm_prefork_module' "$conf"; then
        printf "\n# PHP's module is non-threadsafe, so the prefork MPM is required.\nLoadModule mpm_prefork_module %s\n" "$modpath" >>"$conf"
        MPM_CHANGED=1
    fi
    [ "$MPM_CHANGED" = "1" ] && ok "Apache MPM set to prefork (required by the PHP module)"
    return 0
}

start_apache() {
    configure_mpm || true
    if [ "$MPM_CHANGED" = "1" ] && apache_running; then
        info "Restarting Apache to apply the MPM change"
        httpd -k stop >/dev/null 2>&1 || true
        sleep 1
    fi
    if apache_running; then ok "Apache already running"; return 0; fi
    info "Starting Apache"
    httpd -k start || die "httpd failed to start — see the error above, or $PREFIX/var/log/apache2/error_log"
    local i
    for i in $(seq 1 20); do
        apache_running && { ok "Apache is up on port $PORT"; return 0; }
        sleep 0.5
    done
    die "Apache started but nothing answers on port $PORT"
}

stop_apache() {
    if apache_running; then
        httpd -k stop >/dev/null 2>&1 || true
        sleep 1
        if apache_running; then warn "Apache still listening on port $PORT"; else ok "Apache stopped"; fi
    else
        ok "Apache was not running"
    fi
}

create_database() {
    info "Creating database and user"
    mariadb -u root <<SQL || die "Could not create the DVWA database"
CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'localhost';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
    ok "Database '$DB_NAME' ready (user $DB_USER / $DB_PASS)"
}

fetch_dvwa() {
    info "Fetching DVWA source"
    if [ -d "$DVWA_HOME/.git" ]; then
        git -C "$DVWA_HOME" pull --ff-only || warn "git pull failed, keeping the existing copy"
    else
        rm -rf "$DVWA_HOME"
        git clone --depth 1 https://github.com/digininja/DVWA.git "$DVWA_HOME" \
            || die "git clone failed — check your connection"
    fi
    ok "DVWA is in $DVWA_HOME"
}

configure_dvwa() {
    info "Writing DVWA config"
    local dist="$DVWA_HOME/config/config.inc.php.dist"
    local conf="$DVWA_HOME/config/config.inc.php"
    [ -f "$dist" ] || die "config.inc.php.dist not found — clone may be incomplete"
    cp "$dist" "$conf"
    sed -i \
        -e "s|^\(\$_DVWA\[ *'db_server' *\][[:space:]]*=[[:space:]]*\).*|\1'$HOST';|" \
        -e "s|^\(\$_DVWA\[ *'db_database' *\][[:space:]]*=[[:space:]]*\).*|\1'$DB_NAME';|" \
        -e "s|^\(\$_DVWA\[ *'db_user' *\][[:space:]]*=[[:space:]]*\).*|\1'$DB_USER';|" \
        -e "s|^\(\$_DVWA\[ *'db_password' *\][[:space:]]*=[[:space:]]*\).*|\1'$DB_PASS';|" \
        -e "s|^\(\$_DVWA\[ *'default_security_level' *\][[:space:]]*=[[:space:]]*\).*|\1'low';|" \
        "$conf"
    grep -q "db_password' *\][[:space:]]*=[[:space:]]*'$DB_PASS';" "$conf" \
        || warn "Could not rewrite $conf automatically — edit it by hand"
    ok "Configured $conf"
}

configure_php() {
    info "Tuning PHP for the lab"
    local ini="$PREFIX/etc/php/php.ini"
    mkdir -p "$PREFIX/etc/php"
    if [ ! -f "$ini" ]; then
        if [ -f "$PREFIX/share/doc/php/php.ini-production" ]; then
            cp "$PREFIX/share/doc/php/php.ini-production" "$ini"
        else
            : >"$ini"
        fi
    fi
    if ! grep -q 'dvwa lab overrides' "$ini"; then
        cat >>"$ini" <<'INI'

; --- dvwa lab overrides ---
allow_url_fopen = On
allow_url_include = On
display_errors = On
error_reporting = E_ALL
INI
    fi
    ok "PHP settings applied"
}

configure_apache() {
    info "Wiring PHP into Apache"
    [ -f "$PREFIX/libexec/apache2/libphp.so" ] \
        || die "Install the Apache PHP module first: pkg install php-apache"
    local conf="$PREFIX/etc/apache2/conf.d/dvwa.conf"
    cat >"$conf" <<CONF
# DVWA lab — reachable from this phone only.
LoadModule php_module libexec/apache2/libphp.so
Alias /dvwa "$DVWA_HOME"
DirectoryIndex index.php index.html
<Directory "$DVWA_HOME">
    Options +FollowSymLinks
    AllowOverride All
    Require all granted
</Directory>
<FilesMatch \.php$>
    SetHandler application/x-httpd-php
</FilesMatch>
CONF

    # Keep the lab on localhost so nobody on the same Wi-Fi can reach it.
    local httpd="$PREFIX/etc/apache2/httpd.conf"
    if grep -q '^Listen 8080' "$httpd"; then
        sed -i 's|^Listen 8080|Listen 127.0.0.1:8080|' "$httpd"
        ok "Apache bound to 127.0.0.1:8080"
    elif grep -q '^Listen 127.0.0.1:8080' "$httpd"; then
        ok "Apache already bound to 127.0.0.1:8080"
    else
        warn "Unexpected Listen line in $httpd — leaving it alone"
    fi
    ok "Apache config written to $conf"
}

do_install() {
    need_termux
    info "Updating Termux packages"
    pkg update -y || warn "pkg update had problems, continuing"

    info "Installing Apache, PHP and MariaDB (this takes a few minutes)"
    # NOTE: libphp.so ships in the separate 'php-apache' package, not in 'php'.
    pkg install -y apache2 php php-apache php-gd mariadb git || die "pkg install failed"
    [ -f "$PREFIX/libexec/apache2/libphp.so" ] \
        || die "libphp.so is missing — run: pkg install php-apache"

    start_mysql
    create_database
    fetch_dvwa
    configure_dvwa
    configure_php
    configure_apache
    start_apache

    printf '\n%s%s%s\n' "$c_ok" "────────────────────────────────────────────" "$c_off"
    printf '%s  DVWA is ready%s\n' "$c_ok" "$c_off"
    printf '  1. Open:  %s/setup.php\n' "$LAB_URL"
    printf '  2. Tap "Create / Reset Database"\n'
    printf '  3. Login: admin / password\n'
    printf '  Start later:  bash %s start\n' "$0"
    printf '%s%s%s\n' "$c_ok" "────────────────────────────────────────────" "$c_off"
}

show_status() {
    if mysql_running; then ok "MariaDB: running"; else warn "MariaDB: stopped"; fi
    if apache_running; then ok "Apache:  running"; else warn "Apache:  stopped"; fi
    [ -d "$DVWA_HOME" ] && ok "DVWA files: $DVWA_HOME" || warn "DVWA files: not installed"
}

case "${1:-}" in
    install) do_install ;;
    start)   start_mysql; start_apache; printf '\nLab: %s/setup.php\n' "$LAB_URL" ;;
    stop)    stop_apache; stop_mysql ;;
    status)  show_status ;;
    url)     printf '%s/setup.php\n' "$LAB_URL" ;;
    *)
        printf 'Usage: bash %s {install|start|stop|status|url}\n' "$0"
        exit 1
        ;;
esac
