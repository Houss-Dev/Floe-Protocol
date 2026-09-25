import re,os,json,subprocess,sys,urllib.request

REG=os.path.expanduser('~/.cargo/registry/src/index.crates.io-6f17d22bba15001f')
MAX_RUSTC=(1,79)

def parse_rustc(s):
    m=re.search(r'rust-version\s*=\s*"(\d+)\.(\d+)', s)
    return (int(m.group(1)),int(m.group(2))) if m else None

def offenders():
    lock=open('Cargo.lock').read()
    pkgs=re.findall(r'\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"', lock)
    out={}
    for n,v in pkgs:
        p=os.path.join(REG,f'{n}-{v}','Cargo.toml')
        if not os.path.exists(p): continue
        t=open(p,errors='ignore').read()
        if re.search(r'edition\s*=\s*"2024"', t):
            out.setdefault(n,v); continue
        rv=parse_rustc(t)
        if rv and rv>MAX_RUSTC:
            out.setdefault(n,v)
    return out

def newest_compatible(name):
    url=f'https://crates.io/api/v1/crates/{name}'
    req=urllib.request.Request(url, headers={'User-Agent':'ledgerline-bootstrap'})
    d=json.load(urllib.request.urlopen(req, timeout=30))
    cands=[]
    for v in d['versions']:
        if v['yanked']: continue
        num=v['num']
        if '+' in num or '-' in num: continue
        rv=v.get('rust_version')
        if rv:
            parts=tuple(int(x) for x in rv.split('.')[:2])
            if parts>MAX_RUSTC: continue
        cands.append(num)
    def key(s):
        return tuple(int(x) for x in re.findall(r'\d+', s)[:3])
    return sorted(cands, key=key)[-1] if cands else None

for it in range(15):
    subprocess.run(['cargo','fetch'],capture_output=True)
    bad=offenders()
    if not bad:
        print(f'iter {it}: lockfile compatible with rustc 1.79'); sys.exit(0)
    print(f'iter {it}: {len(bad)} offender(s)')
    for n,v in sorted(bad.items()):
        tgt=newest_compatible(n)
        if not tgt:
            print(f'  {n}@{v}: no compatible version found'); continue
        r=subprocess.run(['cargo','update','-p',f'{n}@{v}','--precise',tgt],capture_output=True,text=True)
        if r.returncode!=0:
            r=subprocess.run(['cargo','update','-p',n,'--precise',tgt],capture_output=True,text=True)
        print(f'  {n}@{v} -> {tgt}  {"ok" if r.returncode==0 else "FAILED"}')
        if r.returncode!=0:
            print('    '+ (r.stderr.strip().splitlines() or [''])[0])
print('gave up'); sys.exit(1)
