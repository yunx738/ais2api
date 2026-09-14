import urllib.request,urllib.parse,urllib.error,http.cookiejar,pathlib,json,subprocess
root=pathlib.Path('/opt/ais2api/dual-runtime')
cfg=json.loads((root/'coordinator.json').read_text())
base='http://127.0.0.1:8893'
jar=http.cookiejar.CookieJar()
op=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
def call(route,data=None,headers=None):
    try:
        with op.open(urllib.request.Request(base+route,data=data,headers=headers or {}),timeout=10) as r:
            return r.status,r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code,e.read().decode()
assert call('/import')[0]==401
code,body=call('/login',urllib.parse.urlencode({'apiKey':cfg['apiKeys'][0]}).encode())
assert code==200 and '双实例代理管理' in body
code,body=call('/import')
assert code==200 and 'convertCookies' in body
assert call('/api/switch-account',b'{}',{'Content-Type':'application/json'})[0]==404
assert call('/v1/chat/completions',b'{}',{'Content-Type':'application/json'})[0]==404
assert call('/api/import-account',b'{}',{'Content-Type':'application/json','Origin':'https://example.org'})[0]==403
print('PASS management HTTP: login, dashboard, local converter, import CSRF, generation and switching blocked')
r=subprocess.run(['docker','top','ais2api-dual-management','-eo','comm'],capture_output=True,text=True)
assert r.returncode==0
assert not any(x in r.stdout.lower() for x in ['firefox','camoufox'])
print('PASS management process check: no Firefox/Camoufox')
