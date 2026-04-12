#!/bin/sh
# Blueberry VM Agent — runs as init (PID 1) inside Firecracker microVMs.
# Reads /workspace/_payload.json, executes the code, writes /workspace/_result.json, powers off.
set -e

PAYLOAD="/workspace/_payload.json"
RESULT="/workspace/_result.json"

write_error() {
  printf '{"stdout":"","stderr":"%s","exitCode":1,"timedOut":false}' "$1" > "$RESULT"
  sync
  reboot -f
}

sleep 0.1

[ -f "$PAYLOAD" ] || write_error "Payload not found"

# ---------------------------------------------------------------------------
# Detect runtime
# ---------------------------------------------------------------------------
if command -v python3 > /dev/null 2>&1; then
  RUNTIME="python3"
elif command -v node > /dev/null 2>&1; then
  RUNTIME="node"
else
  write_error "No runtime available in VM"
fi

# ---------------------------------------------------------------------------
# Extract payload fields and write code + uploaded files to /workspace
# ---------------------------------------------------------------------------
if [ "$RUNTIME" = "python3" ]; then
  LANGUAGE=$(python3 -c "import json; print(json.load(open('$PAYLOAD'))['language'])")
  CODE_EXT=$(python3 -c "print('.py' if '$LANGUAGE'=='python' else '.js')")
  TIMEOUT=$(python3 -c "import json; print(json.load(open('$PAYLOAD')).get('timeoutMs',30000)//1000)")

  python3 -c "
import json, base64, os
payload = json.load(open('$PAYLOAD'))
ext = '.py' if payload['language'] == 'python' else '.js'
with open('/workspace/_exec_code' + ext, 'w') as f:
    f.write(payload['code'])
for entry in payload.get('files', []):
    with open(os.path.join('/workspace', entry['name']), 'wb') as f:
        f.write(base64.b64decode(entry['content_base64']))
"
else
  LANGUAGE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PAYLOAD','utf-8')).language)")
  CODE_EXT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PAYLOAD','utf-8')).language==='python'?'.py':'.js')")
  TIMEOUT=$(node -e "console.log(Math.floor((JSON.parse(require('fs').readFileSync('$PAYLOAD','utf-8')).timeoutMs||30000)/1000))")

  node -e "
const fs=require('fs'), path=require('path');
const p=JSON.parse(fs.readFileSync('$PAYLOAD','utf-8'));
const ext=p.language==='python'?'.py':'.js';
fs.writeFileSync('/workspace/_exec_code'+ext, p.code);
for(const f of (p.files||[])){
  fs.writeFileSync(path.join('/workspace',f.name), Buffer.from(f.content_base64,'base64'));
}
"
fi

EXEC_FILE="/workspace/_exec_code${CODE_EXT}"

# ---------------------------------------------------------------------------
# Run the user's code with a timeout
# ---------------------------------------------------------------------------
STDOUT_FILE="/tmp/exec_stdout"
STDERR_FILE="/tmp/exec_stderr"
EXIT_CODE=0
TIMED_OUT="false"

cd /workspace

if [ "$LANGUAGE" = "python" ]; then
  timeout "${TIMEOUT}s" python3 -u "$EXEC_FILE" > "$STDOUT_FILE" 2> "$STDERR_FILE" || EXIT_CODE=$?
else
  timeout "${TIMEOUT}s" node "$EXEC_FILE" > "$STDOUT_FILE" 2> "$STDERR_FILE" || EXIT_CODE=$?
fi

[ "$EXIT_CODE" = "124" ] && TIMED_OUT="true"

# ---------------------------------------------------------------------------
# Write _result.json with proper JSON escaping via the available runtime.
# Shell variables ($EXIT_CODE, $TIMED_OUT) are interpolated by sh before the
# runtime sees the script — this is intentional.
# ---------------------------------------------------------------------------
if [ "$RUNTIME" = "python3" ]; then
  python3 -c "
import json
stdout = stderr = ''
try:
    with open('/tmp/exec_stdout') as f: stdout = f.read()
except Exception: pass
try:
    with open('/tmp/exec_stderr') as f: stderr = f.read()
except Exception: pass
json.dump({
    'stdout': stdout,
    'stderr': stderr,
    'exitCode': $EXIT_CODE,
    'timedOut': $([ "$TIMED_OUT" = "true" ] && echo True || echo False)
}, open('$RESULT', 'w'))
"
else
  node -e "
const fs = require('fs');
const stdout = fs.existsSync('/tmp/exec_stdout') ? fs.readFileSync('/tmp/exec_stdout','utf-8') : '';
const stderr = fs.existsSync('/tmp/exec_stderr') ? fs.readFileSync('/tmp/exec_stderr','utf-8') : '';
fs.writeFileSync('$RESULT', JSON.stringify({
  stdout, stderr,
  exitCode: $EXIT_CODE,
  timedOut: $([ "$TIMED_OUT" = "true" ] && echo true || echo false)
}));
"
fi

sync
reboot -f
