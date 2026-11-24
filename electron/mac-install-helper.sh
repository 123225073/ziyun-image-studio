# Run by /bin/sh independently of the bundle that is being replaced.
# Paths are passed as individual arguments. Nothing is run with elevation.
owner_pid=$1
target=$2
stage=$3
original=$4
replacement=$5
swap_script=$6
carry_drafts=$7
candidate="$stage/子云影像工坊.app"

identity() { /usr/bin/stat -f '%i' "$1" 2>/dev/null; }
notify_failure() {
  /usr/bin/osascript -e 'display notification "请打开工坊重新检查更新，或从 GitHub 发布页下载安装。" with title "子云影像工坊更新未完成"' >/dev/null 2>&1
}
show_backup() {
  /usr/bin/open -R "$candidate"
  /usr/bin/osascript -e 'display notification "旧版应用已在访达中显示。需要回退时，请先退出工坊，再将旧版拷贝回原应用程序文件夹。" with title "新版工坊尚未确认启动"' >/dev/null 2>&1
}
safe_to_restore() {
  # A system security prompt can outlive open(1). Leave the verified
  # backup in place when a prompt, a running app or an uncertain state exists.
  apps=$(/usr/bin/osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.ziyun.imagestudio").count' 2>/dev/null)
  [ "$apps" = "0" ] || return 1
  agents=$(/bin/ps -A -o comm=) || return 1
  if printf '%s\n' "$agents" | /usr/bin/grep -Eq '/(CoreServicesUIAgent|SecurityAgent|SecurityAgentHelper)$'; then return 1; fi
  [ ! -f "$stage/started" ]
}
drop_candidate() {
  # During rollback the new bundle has been returned to staging.
  if [ "$(identity "$target")" = "$original" ] && [ "$(identity "$candidate")" = "$replacement" ]; then
    /bin/rm -rf "$candidate"
    /bin/rm -f "$stage/receipt.json"
    /bin/rmdir "$stage"
  fi
}
open_original() {
  if [ "$carry_drafts" = "1" ]; then
    # The original version can consume its pending edits on its own startup.
    (umask 077; : > "$stage/rolled-back")
  else
    drop_candidate
  fi
  /usr/bin/open "$target"
}
exchange() {
  # Darwin's RENAME_SWAP keeps one complete, usable app at the target even
  # if power is lost between replacement and relaunch. No two-step rename.
  /usr/bin/osascript -l JavaScript -e "$swap_script" "$target" "$candidate" >/dev/null 2>&1
}

waited=0
while kill -0 "$owner_pid" 2>/dev/null; do
  if [ "$waited" -ge 120 ]; then
    drop_candidate
    notify_failure
    exit 1
  fi
  /bin/sleep 1
  waited=$((waited + 1))
done

# A person may have moved or replaced an application during the download.
if [ "$(identity "$target")" != "$original" ] || [ "$(identity "$candidate")" != "$replacement" ]; then
  notify_failure
  exit 1
fi
exchange
if [ "$(identity "$target")" = "$original" ]; then
  open_original
  notify_failure
  exit 1
fi
if [ "$(identity "$target")" != "$replacement" ] || [ "$(identity "$candidate")" != "$original" ]; then
  notify_failure
  exit 1
fi

# LaunchServices presents normal Gatekeeper and application-management UI.
# The new app cleans up its verified backup when its first window is ready.
# open may return success before LaunchServices has finished opening it.
if /usr/bin/open "$target"; then
  waited=0
  while [ "$waited" -lt 180 ]; do
    if [ ! -d "$candidate" ] || [ -f "$stage/started" ]; then exit 0; fi
    /bin/sleep 1
    waited=$((waited + 1))
  done
fi
if [ "$(identity "$target")" = "$replacement" ] && [ "$(identity "$candidate")" = "$original" ]; then
  if ! safe_to_restore; then
    if [ ! -f "$stage/started" ] && [ -d "$candidate" ]; then show_backup; fi
    exit 1
  fi
  exchange
  if [ "$(identity "$target")" = "$original" ]; then
    open_original
  else
    show_backup
  fi
fi
notify_failure
exit 1
