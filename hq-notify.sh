#!/bin/bash
# Forwards Claude Code hook events to HQ server. Arg $1 = event name.
EVENT=$1
python3 -c "
import sys, json, urllib.request, os, time
try:
    data = json.load(sys.stdin)
    payload = json.dumps({
        'event': '$EVENT',
        'session_id': data.get('session_id', ''),
        'cwd': os.getcwd(),
        'ts': time.time(),
        'data': data
    }).encode()
    req = urllib.request.Request(
        'http://localhost:4242/api/hook',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    urllib.request.urlopen(req, timeout=2)
except:
    pass
" 2>/dev/null
