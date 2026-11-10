#!/bin/sh
set -eu
umask 077
repository=rishiqing/rsq-cli
root=${RSQ_INSTALL_DIR:-"${XDG_DATA_HOME:-$HOME/.local/share}/rsq"}
bin=${RSQ_BIN_DIR:-"$HOME/.local/bin"}
case "$root" in /*) ;; *) printf 'RSQ_INSTALL_DIR 必须为绝对路径。\n' >&2; exit 1;; esac
case "$bin" in /*) ;; *) printf 'RSQ_BIN_DIR 必须为绝对路径。\n' >&2; exit 1;; esac
for command in curl tar mktemp; do command -v "$command" >/dev/null 2>&1 || { printf '缺少安装工具：%s\n' "$command" >&2; exit 1; }; done
case $(uname -s) in Linux) platform=linux;; Darwin) platform=darwin;; *) printf '当前系统请使用 Windows PowerShell 安装脚本。\n' >&2; exit 1;; esac
case $(uname -m) in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) printf '不支持当前 CPU 架构。\n' >&2; exit 1;; esac
if [ "$platform" = linux ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then printf '当前安装包需要 glibc，不支持此 musl 系统。\n' >&2; exit 1; fi
fetch() { curl -fLsS --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 240 "$1" -o "$2"; }
mkdir -p "$root/versions" "$bin"
if ! mkdir "$root/.update-lock" 2>/dev/null; then printf '另一个安装或升级正在运行，请稍后重试。\n' >&2; exit 1; fi
temporary=
cleanup() { [ -z "$temporary" ] || rm -rf "$temporary"; rmdir "$root/.update-lock" 2>/dev/null || true; }
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM HUP
temporary=$(mktemp -d "$root/.install.XXXXXX")
version=${RSQ_VERSION:-}
if [ -z "$version" ]; then fetch "https://raw.githubusercontent.com/$repository/main/latest.json" "$temporary/latest.json"; version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$temporary/latest.json"); fi
version=${version#v}
if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+([.-][a-zA-Z0-9]+)*)?$'; then printf 'Release 版本无效。\n' >&2; exit 1; fi
filename="rsq-$version-$platform-$arch.tar.gz"
base="https://github.com/$repository/releases/download/v$version"
printf '正在安装 rsq %s（%s-%s）…\n' "$version" "$platform" "$arch" >&2
fetch "$base/SHA256SUMS" "$temporary/SHA256SUMS"
fetch "$base/$filename" "$temporary/release.tar.gz"
expected=$(awk -v filename="$filename" '$2 == filename {print $1}' "$temporary/SHA256SUMS")
case "$expected" in ''|*[!0-9a-fA-F]*) printf '缺少有效的 SHA256 校验值。\n' >&2; exit 1;; esac
[ "${#expected}" -eq 64 ] || { printf 'SHA256 校验值无效。\n' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temporary/release.tar.gz" | awk '{print $1}'); elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$temporary/release.tar.gz" | awk '{print $1}'); else printf '缺少 SHA256 校验工具。\n' >&2; exit 1; fi
[ "$actual" = "$expected" ] || { printf 'SHA256 校验失败，当前安装保持不变。\n' >&2; exit 1; }
tar -tzf "$temporary/release.tar.gz" > "$temporary/entries"
if grep -Eq '(^/|(^|/)\.\.(/|$)|\\|:)' "$temporary/entries"; then printf '安装包包含不安全的路径。\n' >&2; exit 1; fi
tar -tvzf "$temporary/release.tar.gz" > "$temporary/types"
if grep -Ev '^[d-]' "$temporary/types" | grep -q .; then printf '安装包不能包含链接或特殊设备。\n' >&2; exit 1; fi
mkdir "$temporary/release"
tar -xzf "$temporary/release.tar.gz" -C "$temporary/release"
chmod 755 "$temporary/release/node"
reported=$("$temporary/release/node" "$temporary/release/package/dist/cli.js" --version)
[ "$reported" = "$version" ] || { printf '安装版本核对失败，当前安装保持不变。\n' >&2; exit 1; }
selected="$version-$platform-$arch-$(basename "$temporary")"
mv "$temporary/release" "$root/versions/$selected"
if [ -f "$root/current" ]; then cp "$root/current" "$root/.previous.tmp"; mv -f "$root/.previous.tmp" "$root/previous"; fi
printf '%s\n' "$selected" > "$root/.current.tmp"
printf '%s\n' "$root" > "$bin/.rsq-install-root.tmp"
cat > "$bin/.rsq-launcher.tmp" <<'LAUNCHER'
#!/bin/sh
set -eu
bindir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IFS= read -r root < "$bindir/.rsq-install-root"
IFS= read -r selected < "$root/current"
case "$selected" in ''|*[!a-zA-Z0-9._-]*) printf 'rsq 安装版本指针无效。\n' >&2; exit 1;; esac
exec "$root/versions/$selected/node" "$root/versions/$selected/package/dist/cli.js" "$@"
LAUNCHER
chmod 755 "$bin/.rsq-launcher.tmp"
mv -f "$root/.current.tmp" "$root/current"
mv -f "$bin/.rsq-install-root.tmp" "$bin/.rsq-install-root"
mv -f "$bin/.rsq-launcher.tmp" "$bin/rsq"
printf '已安装 rsq %s：%s/rsq\n' "$version" "$bin" >&2
case ":$PATH:" in *":$bin:"*) ;; *) printf '当前终端执行：export PATH="%s:$PATH"\n' "$bin" >&2;; esac

if [ "$bin" = "$HOME/.local/bin" ]; then
  case "${SHELL:-}" in */zsh) profile="$HOME/.zshrc";; */bash) if [ "$platform" = darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi;; *) profile="$HOME/.profile";; esac
  line='export PATH="$HOME/.local/bin:$PATH"'
  if ! grep -Fqx "$line" "$profile" 2>/dev/null; then
    if ! printf '\n%s\n' "$line" >> "$profile"; then printf '请手动将 %s 加入 PATH。\n' "$bin" >&2; fi
  fi
fi
