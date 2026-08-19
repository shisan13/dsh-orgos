#!/usr/bin/env bash
# dsh-orgos 测试装配脚本:手动打包 workspace 包为可安装 tgz
# (绕过 pnpm/npm pack 对 workspace 依赖的行为差异;发布仍走 pnpm publish)
# 用法: scripts/assemble-packs.sh [--dest DIR]
set -euo pipefail
DEST="${2:-/tmp/orgos-packs}"
mkdir -p "$DEST"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKS=("core" "im-gateway" "im-feishu" "tools" "ui" "bundle")
NAME_MAP=("core:dsh-orgos-core" "im-gateway:dsh-orgos-im-gateway" "im-feishu:dsh-orgos-im-feishu" "tools:dsh-orgos-tools" "ui:dsh-orgos-ui" "bundle:dsh-orgos")

declare -A PKG_NAME
for entry in "${NAME_MAP[@]}"; do PKG_NAME["${entry%%:*}"]="${entry#*:}"; done

# 先构建全部已实现包(跳过空目录)
for dir in "${PACKS[@]}"; do
  if [ -f "$ROOT/packages/$dir/package.json" ] && [ -d "$ROOT/packages/$dir/src" ]; then
    (cd "$ROOT" && pnpm --filter "${PKG_NAME[$dir]}" build >/dev/null 2>&1 || true)
  fi
done

# 打包:package.json(依赖重写 file:)+ files 字段内容
for dir in "${PACKS[@]}"; do
  pkg="$ROOT/packages/$dir"
  [ -f "$pkg/package.json" ] || continue
  name="${PKG_NAME[$dir]}"
  version="$(python3 -c "import json; print(json.load(open('$pkg/package.json'))['version'])")"
  tgz="$DEST/$name-$version.tgz"
  work="$(mktemp -d)"
  mkdir -p "$work/package"
  cp "$pkg/package.json" "$work/package/package.json"
  # files 字段列出内容(默认 lib + 包内资产)
  python3 - "$pkg" "$work/package" "$DEST" <<'PYEOF'
import json, os, shutil, sys
pkg, dest, packdir = sys.argv[1], sys.argv[2], sys.argv[3]
pj = json.load(open(os.path.join(pkg, 'package.json')))
# 依赖重写:workspace:^ / ^0.1.0 → file:DEST/name-version.tgz
deps = pj.get('dependencies', {})
name2file = {}
for f in os.listdir(packdir):
    if f.endswith('.tgz'):
        nm = f.rsplit('-', 1)[0]
        name2file[nm] = f'file:{packdir}/{f}'
for k in list(deps):
    if k in name2file:
        deps[k] = name2file[k]
if deps:
    pj['dependencies'] = deps
json.dump(pj, open(os.path.join(dest, 'package.json'), 'w'), indent=2, ensure_ascii=False)
# files 字段复制
files = pj.get('files', ['lib'])
for pat in files:
    src = os.path.join(pkg, pat)
    if os.path.isdir(src):
        shutil.copytree(src, os.path.join(dest, os.path.basename(pat)), dirs_exist_ok=True)
    elif os.path.isfile(src):
        shutil.copy2(src, dest)
PYEOF
  tar -czf "$tgz" -C "$work" package
  rm -rf "$work"
  echo "$tgz"
done
