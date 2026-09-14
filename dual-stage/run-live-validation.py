from pathlib import Path
s=Path('/tmp/ais-live-command.txt').read_text()
start=s.find('from pathlib import Path')
end=s.rfind(chr(10)+'PY')
assert start>=0 and end>start
code=s[start:end].replace(chr(92)+chr(34),chr(34))
assert 'LIVE_GENERATION_PASSED' in code
compile(code,'live-validation','exec')
p=Path('/opt/ais2api/dual-stage/run-live-validation.py')
p.write_text(code);p.chmod(0o700)
print('LIVE_SCRIPT_COMPILED')