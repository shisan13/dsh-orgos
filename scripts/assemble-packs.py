#!/usr/bin/env python3
"""dsh-orgos 测试装配:手动打包 workspace 包为可安装 tgz(绕过 pnpm/npm pack 行为差异)。
发布仍走 pnpm publish;本脚本仅本地测试装配用。
用法: python3 scripts/assemble-packs.py [--dest DIR]
"""
import json, os, shutil, subprocess, sys, tarfile, tempfile

DEST = sys.argv[sys.argv.index('--dest') + 1] if '--dest' in sys.argv else '/tmp/orgos-packs'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS = {
    'core': 'dsh-orgos-core',
    'im-gateway': 'dsh-orgos-im-gateway',
    'im-feishu': 'dsh-orgos-im-feishu',
    'tools': 'dsh-orgos-tools',
    'ui': 'dsh-orgos-ui',
    'im-telegram': 'dsh-orgos-im-telegram',
    'im-wecom': 'dsh-orgos-im-wecom',
    'im-dingtalk': 'dsh-orgos-im-dingtalk',
    'im-slack': 'dsh-orgos-im-slack',
    'im-discord': 'dsh-orgos-im-discord',
    'im-whatsapp': 'dsh-orgos-im-whatsapp',
    'bundle': 'dsh-orgos',
}
os.makedirs(DEST, exist_ok=True)

# 1. 构建(跳过未实现的包)
for d in PACKS:
    pkg = os.path.join(ROOT, 'packages', d)
    if os.path.isdir(os.path.join(pkg, 'src')) and os.path.isfile(os.path.join(pkg, 'package.json')):
        subprocess.run(['pnpm', '--filter', PACKS[d], 'build'], cwd=ROOT, capture_output=True)

# 2. 打包:package.json(依赖重写 file:)+ files 字段内容
for d, name in PACKS.items():
    pkg = os.path.join(ROOT, 'packages', d)
    pjf = os.path.join(pkg, 'package.json')
    if not os.path.isfile(pjf):
        continue
    pj = json.load(open(pjf))
    version = pj['version']
    tgz = os.path.join(DEST, f'{name}-{version}.tgz')
    work = tempfile.mkdtemp()
    pkgdir = os.path.join(work, 'package')
    os.makedirs(pkgdir)
    deps = pj.get('dependencies', {})
    name2file = {}
    for f in os.listdir(DEST):
        if f.endswith('.tgz'):
            name2file[f.rsplit('-', 1)[0]] = f'file:{DEST}/{f}'
    for k in list(deps):
        if k in name2file and k != pj['name']:
            deps[k] = name2file[k]
    if deps:
        pj['dependencies'] = deps
    json.dump(pj, open(os.path.join(pkgdir, 'package.json'), 'w'), indent=2, ensure_ascii=False)
    for pat in pj.get('files', ['lib']):
        src = os.path.join(pkg, pat)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(pkgdir, os.path.basename(pat)), dirs_exist_ok=True)
        elif os.path.isfile(src):
            shutil.copy2(src, pkgdir)
    with tarfile.open(tgz, 'w:gz') as tf:
        tf.add(pkgdir, arcname='package')
    shutil.rmtree(work)
    print(tgz)
print('assembled OK')
