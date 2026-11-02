import base64, os, pty, select, subprocess, sys, time, fcntl, termios, struct
screen = b''

def session(restarted=False):
    global screen
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 160, 0, 0))
    proc = subprocess.Popen([sys.argv[1], sys.argv[2], 'launch', sys.argv[3]], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    seen = b''
    def read():
        global screen
        nonlocal seen
        chunk = os.read(master, 65536)
        if b'\x1b[6n' in chunk: os.write(master, b'\x1b[1;1R')
        screen += chunk; seen += chunk
    def wait_for(text):
        nonlocal seen
        deadline = time.time() + 12
        while text.encode() not in seen:
            if time.time() > deadline: raise RuntimeError('PTY timeout waiting for ' + text)
            if select.select([master], [], [], .1)[0]: read()
        seen = b''
    def send(text):
        os.write(master, text.encode()); time.sleep(.1); os.write(master, b'\r')
    try:
        wait_for('epoch=1')
        send('first question'); wait_for('ANSWER_OK')
        send('/evidence'); wait_for('[1]')
        send('/evidence 1'); wait_for('"count": 7')
        send('/evidence 999'); wait_for('Evidence unavailable in this epoch')
        send('/evidence ../secret'); wait_for('Usage: /evidence')
        send('follow up'); wait_for('FOLLOWUP_OK')
        for command in ['/compact','/resume stale','/import stale','/export file','/share','/reload','!cat AGENTS.md']:
            send(command); wait_for('Unsupported command.')
            send('/help'); wait_for('No shell, attachments')
        if not restarted:
            send('/policy schema'); wait_for('epoch=2')
            send('/evidence 1'); wait_for('Evidence unavailable in this epoch')
            send('new question'); wait_for('ANSWER_OK')
            send('/model claude'); wait_for('epoch=3')
            send('anthropic question'); wait_for('ANSWER_OK')
            send('/project other'); wait_for('epoch=4')
            send('/policy business'); wait_for('epoch=5')
            send('business question'); wait_for('ANSWER_OK')
            send('/metadata'); wait_for('Available within deployment policy:')
            send('/metadata knowledge.rules=rules'); wait_for('epoch=6')
            send('custom question'); wait_for('ANSWER_OK')
            send('/metadata context=*'); wait_for('Invalid metadata selection.')
            send('/metadata none'); wait_for('epoch=7')
            send('tightened question'); wait_for('ANSWER_OK')
            send('/policy schema'); wait_for('epoch=8')
            send('HOLD_REQUEST'); time.sleep(.2)
            os.write(master, b'\x03')  # cancel an in-flight request and close TUI
        else: send('/quit')
        deadline = time.time() + 6
        while proc.poll() is None and time.time() < deadline:
            if select.select([master], [], [], .1)[0]:
                try: read()
                except OSError: break
        proc.wait(timeout=1)
        if proc.returncode != 0: raise RuntimeError('launcher failed')
    finally:
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=3)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
        os.close(master)

session()
session(restarted=True)
print('PTY_OK: both providers, follow-up, commands, resets, Ctrl+C, restart')
print('SCREEN_BASE64:' + base64.b64encode(screen).decode())
