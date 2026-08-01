#!/usr/bin/env bash
# A throwaway IMAP server on localhost, so inbound mail can be exercised for real without a
# Gmail account, an app password, or any credential worth protecting.
#
#   sudo scripts/dev-mailbox.sh start     # dovecot on 127.0.0.1:10143
#   scripts/dev-mailbox.sh deliver <file.pdf> [more.pdf ...]
#   scripts/dev-mailbox.sh stop
#
# Then point the backend at it:
#   INBOUND_IMAP_HOST=127.0.0.1 INBOUND_IMAP_PORT=10143 INBOUND_IMAP_SECURE=false \
#   INBOUND_IMAP_USER=ap@test.local INBOUND_IMAP_PASSWORD=testpass \
#   INBOUND_TENANT_ID=<tenant> npx ts-node src/main.ts
#
# Why this rather than a real mailbox: it needs no secrets, works offline, and is
# deterministic — you control exactly which messages exist. Use a real provider only when
# testing provider-specific behaviour (see CLAUDE.md on Gmail app passwords and the fact that
# Microsoft 365 no longer accepts basic IMAP auth at all).
set -euo pipefail

DIR=${DEV_MAILBOX_DIR:-/tmp/flowap-dev-mailbox}
USER_ADDR=ap@test.local
PASSWORD=testpass
PORT=${DEV_MAILBOX_PORT:-10143}
MAIL_UID=${DEV_MAILBOX_UID:-5000}

start() {
  command -v dovecot >/dev/null || { echo "dovecot not installed: apt-get install dovecot-imapd"; exit 1; }

  id -u vmail >/dev/null 2>&1 || useradd -u "$MAIL_UID" -s /usr/sbin/nologin vmail 2>/dev/null || true

  mkdir -p "$DIR/run" "$DIR/mail/$USER_ADDR"/{cur,new,tmp}
  cat > "$DIR/dovecot.conf" <<EOF
protocols = imap
listen = 127.0.0.1
base_dir = $DIR/run
log_path = $DIR/dovecot.log
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
mail_location = maildir:$DIR/mail/%u
# dovecot refuses to run mail processes as root, so the maildir is owned by an
# unprivileged uid and these bounds are widened to admit it.
first_valid_uid = 100
first_valid_gid = 100

passdb {
  driver = static
  args = password=$PASSWORD
}

userdb {
  driver = static
  args = uid=$MAIL_UID gid=$MAIL_UID home=$DIR/mail/%u
}

service imap-login {
  inet_listener imap {
    port = $PORT
  }
}
EOF
  chown -R "$MAIL_UID:$MAIL_UID" "$DIR/mail"
  # stdio redirected: dovecot forks, and its children inherit these descriptors. A caller
  # piping this script would otherwise hang forever waiting for an EOF that never comes.
  dovecot -c "$DIR/dovecot.conf" >/dev/null 2>&1 </dev/null
  sleep 1
  echo "IMAP ready on 127.0.0.1:$PORT  user=$USER_ADDR  password=$PASSWORD"
}

stop() {
  pkill -f "dovecot -c $DIR" 2>/dev/null || true
  echo "stopped"
}

# Delivers one message per file, plus the noise a real mailbox carries: an Outlook signature
# image and an Office attachment, so the filtering is exercised rather than assumed.
deliver() {
  [ $# -gt 0 ] || { echo "usage: dev-mailbox.sh deliver <file.pdf> [...]"; exit 1; }
  MAILDIR="$DIR/mail/$USER_ADDR/new" python3 - "$@" <<'PY'
import email.utils, os, sys, time
from email.message import EmailMessage

maildir = os.environ['MAILDIR']
for i, path in enumerate(sys.argv[1:]):
    m = EmailMessage()
    m['From'] = f'Supplier {i+1} <supplier{i+1}@example.com>'
    m['To'] = 'ap@test.local'
    m['Subject'] = f'Invoice: {os.path.basename(path)}'
    m['Date'] = email.utils.formatdate()
    m['Message-ID'] = f'<{os.path.basename(path)}-{int(time.time()*1000)}@example.com>'
    m.set_content('Please find our invoice attached.')
    with open(path, 'rb') as f:
        m.add_attachment(f.read(), maintype='application', subtype='pdf',
                         filename=os.path.basename(path))
    # Noise every corporate mailbox carries.
    m.add_attachment(b'\x89PNG\r\n\x1a\n' + b'\x00' * 2000,
                     maintype='image', subtype='png', filename='image001.png')
    out = os.path.join(maildir, f'{int(time.time()*1e6)}.{i}.flowap')
    with open(out, 'wb') as f:
        f.write(bytes(m))
    print('delivered', m['Subject'])
PY
  chown -R "$MAIL_UID:$MAIL_UID" "$DIR/mail"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  deliver) shift; deliver "$@" ;;
  *) echo "usage: dev-mailbox.sh {start|stop|deliver <file.pdf> ...}"; exit 1 ;;
esac
