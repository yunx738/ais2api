# Container entry. stdout = JSON lines only. argv: list | mail-auth | run <mail_id>
import json, os, sys, subprocess, time, io, contextlib
sys.path.insert(0, '/src')
os.umask(0o077)
os.chdir('/data')
REAL = sys.stdout
def out(**k):
    REAL.write(json.dumps(k, ensure_ascii=False) + '\n'); REAL.flush()
class Pipe(io.TextIOBase):
    def write(self, s):
        for line in s.splitlines():
            line = line.strip()
            if line: out(type='log', text=line[:300])
        return len(s)
cfg = json.load(open('/data/ws-config.json'))
cfg.update({'profiles_dir': '/data/profiles', 'output_dir': '/data/output', 'accounts_tsv': '/data/output/accounts.tsv',
            'cookies_dir': '/data/output/cookies', 'otp_store': '/data/secrets.json', 'presets_file': '/data/presets.txt',
            'mailbox_token': '/data/mailbox-token.json', 'headless': True})
json.dump(cfg, open('/data/.config.json', 'w'))
def start_proxy():
    up = os.environ.get('WS_UPSTREAM', '')
    if not up: return None
    from urllib.parse import urlparse, unquote
    u = urlparse(up.replace('socks5h://', 'socks5://'))
    remote = f'{u.scheme}://{u.hostname}:{u.port}' + (f'#{unquote(u.username)}:{unquote(u.password or "")}' if u.username else '')
    p = subprocess.Popen(['pproxy', '-l', 'http://127.0.0.1:18995', '-r', remote],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    return {'server': 'http://127.0.0.1:18995'}
mode = sys.argv[1] if len(sys.argv) > 1 else ''
import register
register.HERE = __import__('pathlib').Path('/data')
import mailbox as mb
mb.HERE = register.HERE; mb.TOKEN_FILE = register.HERE / 'mailbox-token.json'
register.CONFIG = register.load_config(register.HERE / '.config.json')
import tempmail
try:
    if mode == 'mail-auth':
        box = mb.Mailbox(register.CONFIG)
        dc = mb._post(f'{mb.AUTHORITY}/devicecode', {'client_id': box.client_id, 'scope': mb.SCOPE})
        out(type='need', kind='device', uri=dc['verification_uri'], code=dc['user_code'])
        end = time.time() + int(dc.get('expires_in', 900))
        while time.time() < end:
            time.sleep(int(dc.get('interval', 5)))
            try:
                tok = mb._post(f'{mb.AUTHORITY}/token', {'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
                                                         'client_id': box.client_id, 'device_code': dc['device_code']})
            except Exception as e:
                body = getattr(e, 'read', lambda: b'')()
                if b'authorization_pending' in body or b'slow_down' in body: continue
                raise RuntimeError('邮箱授权失败')
            box._save(tok); out(type='result', ok=True); break
        else:
            out(type='result', ok=False, message='授权超时')
    elif mode == 'list':
        box = tempmail.make(register.CONFIG)
        items = box.new_account_links()
        out(type='result', ok=True, items=[{'id': t['mail_id'], 'alias': t['alias'], 'time': t['time'], 'subject': t['subject'][:120]} for t in items])
    elif mode == 'run':
        want = sys.argv[2]
        box = tempmail.make(register.CONFIG)
        item = next((t for t in box.new_account_links() if t['mail_id'] == want), None)
        if not item: raise RuntimeError('邮件已处理或不存在')
        item['mailbox'] = box
        import shutil
        prof = register.HERE / 'profiles' / ('mail_' + ''.join(ch for ch in want if ch.isalnum())[:40])
        shutil.rmtree(prof, ignore_errors=True)
        register.CONFIG['profiles_dir_path'] = prof
        if not register.CONFIG.get('recovery_email'):
            register.CONFIG['recovery_email'] = getattr(box, 'address', '')
        proxy = start_proxy()
        if proxy:
            orig = register.Camoufox
            register.Camoufox = lambda **kw: orig(proxy=proxy, geoip=True, **kw)
        run_dir = register.HERE / 'output' / 'runs' / time.strftime('%Y%m%d_%H%M%S')
        run_dir.mkdir(parents=True, exist_ok=True)
        register.acquire_lock()
        try:
            with contextlib.redirect_stdout(Pipe()):
                r = register.run_one(item, register.load_presets(), run_dir)
        finally:
            register.release_lock()
        if r.get('ok'):
            st = register.HERE / 'state.json'
            d = json.loads(st.read_text()) if st.exists() else {}
            d.setdefault('done_mail_ids', []).append(want); st.write_text(json.dumps(d))
            out(type='result', ok=True, account=r.get('account'), cookies=os.path.basename(r.get('cookies', '')))
        else:
            out(type='result', ok=False, account=r.get('account'), message=(r.get('error') or '失败')[:200])
    else:
        out(type='result', ok=False, message='未知操作')
except SystemExit as e:
    msg = str(e)
    if '授权' in msg and 'mailbox.py' in msg: msg = '邮箱未授权，请先点“授权邮箱”'
    out(type='result', ok=False, message=msg[:200])
except Exception as e:
    out(type='result', ok=False, message=f'{type(e).__name__}: {str(e)[:180]}')
