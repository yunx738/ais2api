# cloudflare_temp_email inbox, shaped like Graph messages so register/mailbox logic is reused.
import json, urllib.request
from email import message_from_string, policy
from email.utils import parsedate_to_datetime, getaddresses
from datetime import timezone
import mailbox as mb

def _text(msg):
    parts = []
    for p in (msg.walk() if msg.is_multipart() else [msg]):
        if p.get_content_type() in ('text/html', 'text/plain'):
            try: parts.append(p.get_content())
            except Exception: pass
    return '\n'.join(parts)

class TempBox(mb.Mailbox):
    def __init__(self, config):
        self.cfg = config
        self.api = (config.get('tempmail_api') or '').rstrip('/')
        self.jwt = config.get('tempmail_jwt') or ''
        self.address = config.get('mailbox') or ''
        self.admin = config.get('tempmail_admin') or ''
        if self.admin and self.address: return
        if not self.jwt:
            admin = config.get('tempmail_admin') or ''
            name = config.get('tempmail_name') or ''
            if not admin or not name: raise SystemExit('临时邮箱未设置')
            req = urllib.request.Request(f'{self.api}/admin/new_address',
                data=json.dumps({'name': name, 'enablePrefix': False}).encode(),
                headers={'Content-Type': 'application/json', 'x-admin-auth': admin, 'User-Agent': 'Mozilla/5.0'})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    d = json.loads(r.read())
            except Exception as e:
                raise SystemExit('临时邮箱创建失败（请检查接口密码）')
            self.jwt = d.get('jwt') or ''
            if not self.jwt: raise SystemExit('临时邮箱创建失败')
            self.address = d.get('address') or ''
    def token(self): return self.jwt
    def fetch(self, top=25):
        from urllib.parse import quote
        if self.admin and self.address:
            req = urllib.request.Request(f'{self.api}/admin/mails?limit={min(top,50)}&offset=0&address={quote(self.address)}',
                                         headers={'x-admin-auth': self.admin, 'User-Agent': 'Mozilla/5.0'})
        else:
            req = urllib.request.Request(f'{self.api}/api/mails?limit={min(top,50)}&offset=0',
                                         headers={'Authorization': f'Bearer {self.jwt}', 'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = json.loads(r.read()).get('results', [])
        out = []
        for row in rows:
            m = message_from_string(row.get('raw') or '', policy=policy.default)
            try: t = parsedate_to_datetime(m.get('Date')).astimezone(timezone.utc)
            except Exception: t = None
            iso = (t.isoformat().replace('+00:00', 'Z') if t else (row.get('created_at', '').replace(' ', 'T') + 'Z'))
            to = [a for _, a in getaddresses([m.get('To', '') or '', m.get('Delivered-To', '') or ''])] or [row.get('address', '')]
            out.append({'id': str(row.get('id')), 'subject': str(m.get('Subject', '') or ''), 'receivedDateTime': iso,
                        'toRecipients': [{'emailAddress': {'address': a}} for a in dict.fromkeys([row.get('address', '')] + to) if a][:1],
                        'body': {'content': _text(m)}, 'bodyPreview': ''})
        return out

def make(config):
    return TempBox(config) if (config.get('mail_provider') == 'tempmail') else mb.Mailbox(config)
