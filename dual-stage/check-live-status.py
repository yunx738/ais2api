import urllib.request,urllib.parse,http.cookiejar,pathlib,json
root=pathlib.Path('/opt/ais2api')
env=dict(x.split('=',1) for x in (root/'app.env').read_text().splitlines() if '=' in x)
key=env['API_KEYS'].strip().strip(chr(34)).strip(chr(39))
jar=http.cookiejar.CookieJar()
o=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
base='https://aisbuild.129357.xyz'
o.open(base+'/login',urllib.parse.urlencode({'apiKey':key}).encode(),timeout=20).close()
with o.open(base+'/api/status',timeout=20) as r:
 s=json.load(r)['status']
for k in ['currentAuthIndex','usageCount','browserConnected','initialIndices']:
 print(k,s.get(k))
