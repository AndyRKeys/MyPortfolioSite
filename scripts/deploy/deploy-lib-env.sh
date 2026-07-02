#!/usr/bin/env bash
# This file is sourced by deploy-lib.sh — do not execute directly.
# set -euo pipefail is inherited from the parent shell.

ensure_env_file() {
  dsection "Phase 3: checking .env"

  if [ -f "$ENV_FILE" ]; then
    dstatus envfile status=ok
    dok ".env present at $ENV_FILE"
    return
  fi

  if [ -n "${ENV_TEMPLATE:-}" ] && [ -f "$ENV_TEMPLATE" ]; then
    dstatus envfile status=created reason=copied-from-template
    dinfo ".env not found — copying from template: $ENV_TEMPLATE"
    cp "$ENV_TEMPLATE" "$ENV_FILE"
    dwarn ""
    dwarn "  .env created but not yet configured."
    dwarn "  Edit $ENV_FILE and set all required values before re-running."
    ddie "Configure .env then re-run this script."
  else
    dstatus envfile status=missing reason=no-template
    ddie ".env not found and ENV_TEMPLATE not available. Check your checkout or set ENV_FILE explicitly."
  fi
}

load_env() {
  # Parse .env line-by-line and export each KEY=VALUE directly. Going via
  # `source` would treat values as bash code, so any unescaped paren, space,
  # `$`, backtick, or quote in a password/display name would break the parse
  # and silently drop every variable after it. Reading raw lines avoids that
  # entirely — values are taken verbatim, exactly as written in .env.
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blanks and comments
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Match KEY=VALUE (key must be uppercase/underscore/digit, value is rest of line)
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      # Strip a single matched pair of surrounding quotes (single or double) —
      # common dotenv convention. Unmatched quotes are left intact.
      if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
        value="${BASH_REMATCH[1]}"
      fi
      # Expand a leading ~/ to $HOME/ for path variables. Pure substitution —
      # does not execute bash code, so complex passwords with ~ in other positions
      # are unaffected.
      [[ "$value" == "~/"* ]] && value="$HOME/${value:2}"
      export "$key=$value"
    fi
  done < "$ENV_FILE"
}

# Print the current .env with secret values masked.
# Keys matching *SECRET*|*TOKEN*|*PASS*|*KEY*|*REFRESH*|*CREDENTIAL*|*EMAIL*|*_ID have their
# value replaced with [redacted]. Safe to include in deploy logs.
redact_env() {
  local file="${1:-$ENV_FILE}"
  local sensitive_pattern='SECRET|TOKEN|PASS|KEY|REFRESH|CREDENTIAL|EMAIL|_ID'

  while IFS= read -r line; do
    # Pass through blank lines and comments unchanged
    if [[ "$line" =~ ^[[:space:]]*$ ]] || [[ "$line" =~ ^[[:space:]]*# ]]; then
      echo "$line"
      continue
    fi
    # For KEY=VALUE lines, redact the value if the key is sensitive
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"
      if echo "$key" | grep -qE "$sensitive_pattern"; then
        # Show that a value exists but not what it is
        if [ -n "$val" ]; then
          echo "${key}=[redacted]"
        else
          echo "${key}=(empty)"
        fi
      else
        echo "$line"
      fi
    else
      echo "$line"
    fi
  done < "$file"
}

# _envsync_backup_and_replace <tmp_env> <carried_count> <new_keys_arr_name> <dropped_keys_arr_name> <placeholder_keys_arr_name>
# Backs up ENV_FILE, replaces it atomically with tmp_env, logs the diff summary.
# Returns 1 if placeholder keys require operator action, 0 otherwise.
_envsync_backup_and_replace() {
  local tmp_env="$1" carried_count="$2"
  local -n _new_keys="$3" _dropped_keys="$4" _placeholder_keys="$5"

  # If nothing would change (no new, no dropped) we still rebuild — the
  # template may have re-ordered or re-commented sections — but only swap
  # the file if it actually differs, to avoid noisy timestamps.
  if cmp -s "$tmp_env" "$ENV_FILE"; then
    rm -f "$tmp_env"
    dstatus envsync status=ok carried="$carried_count"
    dok ".env already matches template structure — no changes needed"
    return 0
  fi

  # Back up the old .env, then atomically replace.
  local backup="${ENV_FILE}.bak-$(date '+%Y%m%d-%H%M%S')"
  cp "$ENV_FILE" "$backup"
  mv "$tmp_env" "$ENV_FILE"

  dok "Rebuilt $ENV_FILE from template (backup: $backup)"
  dlog "  carried over: $carried_count keys"
  if [ "${#_new_keys[@]}" -gt 0 ]; then
    # Split new keys into required-action (placeholder) vs optional (empty template value).
    local required_keys=() optional_keys=()
    local k
    for k in "${_new_keys[@]}"; do
      if printf '%s\n' "${_placeholder_keys[@]:-}" | grep -qx "$k"; then
        required_keys+=("$k")
      else
        optional_keys+=("$k")
      fi
    done
    if [ "${#required_keys[@]}" -gt 0 ]; then
      dwarn "  new keys (template default in place — review and set real values):"
      for k in "${required_keys[@]}"; do dwarn "    + $k"; done
    fi
    if [ "${#optional_keys[@]}" -gt 0 ]; then
      dinfo "  new optional keys added (empty by default — configure only if needed):"
      for k in "${optional_keys[@]}"; do dinfo "    + $k"; done
    fi
  fi
  if [ "${#_dropped_keys[@]}" -gt 0 ]; then
    dlog "  dropped keys (not in template — preserved only in backup):"
    local k
    for k in "${_dropped_keys[@]}"; do
      dlog "    - $k"
    done
  fi

  if [ "${#_placeholder_keys[@]}" -gt 0 ]; then
    dstatus envsync status=keys-added carried="$carried_count" added="${#_new_keys[@]}" dropped="${#_dropped_keys[@]}" reason=action-required
    dwarn ""
    dwarn "  Action required: edit $ENV_FILE and set the new vars above before re-running."
    return 1
  fi

  dstatus envsync status=rebuilt carried="$carried_count" added=0 dropped="${#_dropped_keys[@]}"
  return 0
}

# Rebuild .env from the template, carrying over values for any keys still
# present in the template. The template becomes the canonical structure
# (ordering, comments, section headers); the operator's existing values are
# preserved verbatim. Keys no longer in the template are dropped (but the
# previous .env is timestamped and kept as a backup).
#
# Returns 0 if the rebuilt .env contains no template placeholders for new
# keys, 1 if newly-introduced keys still hold their template default and
# need the operator's attention.
sync_env_from_template() {
  dsection "Phase 3b: rebuilding .env from template"

  # ── Phase 1: guard
  if [ -z "${ENV_TEMPLATE:-}" ]; then
    dstatus envsync status=skipped reason=no-template-var
    dwarn "ENV_TEMPLATE not set — .env drift detection disabled (set ENV_TEMPLATE to enable)"
    return 0
  fi
  if [ ! -f "$ENV_TEMPLATE" ]; then
    dstatus envsync status=skipped reason=template-not-found
    dwarn "ENV_TEMPLATE '$ENV_TEMPLATE' not found — .env drift detection skipped"
    return 0
  fi

  # ── Phase 2: load existing
  # Load existing KEY=VALUE pairs into an associative array (raw values,
  # quotes and all). First '=' is the separator.
  declare -A existing_values
  local existing_keys_list=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      local k="${BASH_REMATCH[1]}"
      local v="${BASH_REMATCH[2]}"
      existing_values["$k"]="$v"
      existing_keys_list+="${k}"$'\n'
    fi
  done < "$ENV_FILE"

  # ── Phase 3: walk template
  # Build the new .env in a temp file by walking the template.
  local tmp_env="${ENV_FILE}.sync.$$"
  : > "$tmp_env"

  local template_keys_list=""
  local carried_count=0
  local new_keys=()
  local placeholder_keys=()

  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local template_value="${BASH_REMATCH[2]}"
      template_keys_list+="${key}"$'\n'
      # Carry over only if the existing value is non-empty. An empty
      # ADMIN_EMAIL= in the old file is effectively unset, so fall back
      # to the template default so validate_env / prompt_missing_vars can
      # flag it as a placeholder rather than silently dropping the key.
      if [ -n "${existing_values[$key]:-}" ]; then
        printf '%s=%s\n' "$key" "${existing_values[$key]}" >> "$tmp_env"
        carried_count=$((carried_count + 1))
      else
        printf '%s\n' "$line" >> "$tmp_env"
        new_keys+=("$key")
        # Only flag as a placeholder requiring action if the template value
        # matches a known placeholder pattern (e.g. "change-me", "your-").
        # An empty template value (KEY=) means the key is optional —
        # add it to .env silently and do not block the deploy (#352).
        local is_ph=0
        local pat
        for pat in "${PLACEHOLDER_PATTERNS[@]}"; do
          if [[ "$template_value" == *"$pat"* ]]; then
            is_ph=1
            break
          fi
        done
        [ "$is_ph" = "1" ] && placeholder_keys+=("$key")
      fi
    else
      # Comment, blank line, section header — copy verbatim from template
      printf '%s\n' "$line" >> "$tmp_env"
    fi
  done < "$ENV_TEMPLATE"

  # ── Phase 4: detect dropped keys
  local dropped_keys=()
  while IFS= read -r k; do
    [ -z "$k" ] && continue
    if ! printf '%s' "$template_keys_list" | grep -qx "$k"; then
      dropped_keys+=("$k")
    fi
  done <<< "$existing_keys_list"

  # ── Phase 5: apply
  _envsync_backup_and_replace "$tmp_env" "$carried_count" new_keys dropped_keys placeholder_keys
}

# Log a redacted snapshot of the current .env to the deploy log.
log_env_snapshot() {
  dsection "Active .env (secrets redacted)"
  redact_env "$ENV_FILE" | while IFS= read -r line; do
    dlog "  $line"
  done
}

validate_env() {
  dsection "Phase 4: validating .env"

  local errors=()

  for var in "${REQUIRED_VARS[@]}"; do
    local value="${!var:-}"
    if [ -z "$value" ]; then
      errors+=("$var is not set")
      continue
    fi
    for pattern in "${PLACEHOLDER_PATTERNS[@]}"; do
      if [[ "$value" == *"$pattern"* ]]; then
        errors+=("$var still contains placeholder value ('$pattern') — set a real value")
        break
      fi
    done
  done

  if declare -F extra_env_checks >/dev/null 2>&1; then
    # extra_env_checks should append to the global errors array if needed
    extra_env_checks errors
  fi

  if [ "${#errors[@]}" -gt 0 ]; then
    dstatus env status=failed
    dfail ".env validation failed:"
    for err in "${errors[@]}"; do
      dfail "  • $err"
    done
    dfail ""
    dfail "Current .env contents (secrets redacted) — for debugging:"
    dfail "  file: $ENV_FILE"
    redact_env "$ENV_FILE" | while IFS= read -r line; do
      dfail "    $line"
    done
    ddie "Fix the above .env issues then re-run."
  fi

  dstatus env status=ok
  dok "All required env vars set and valid."
}

# Detect .env values whose meaning has changed across template versions and
# offer to update them. sync_env_from_template carries existing values
# verbatim, so a variable like NGINX_SERVICE=nginx-dev (valid in the old
# split compose files) survives into a world where the unified compose file
# only knows a service called `nginx`. Each migration entry is the form
#   KEY|expected_new_value|deprecated_regex|reason
# If the live value matches the deprecated regex and differs from the
# expected new value, prompt the operator (interactive) or warn loudly
# (non-interactive) and update ENV_FILE in place. Call after load_env so
# the exported vars and ENV_FILE both end up consistent.
migrate_env_values() {
  dsection "Phase 3c: checking for outdated .env values"

  # Vars whose value must reference a real docker-compose service. If the
  # current value isn't in the compose file's actual service list, the
  # deploy will fail later with a confusing "no such service" — catch it
  # here and offer to update .env to a service that does exist.
  local service_vars=(NGINX_SERVICE BACKEND_SERVICE)
  # Preferred replacement when the current value is wrong. Falls back to
  # whatever service does exist if the preferred name isn't there either.
  declare -A preferred=(
    [NGINX_SERVICE]=nginx
    [BACKEND_SERVICE]=backend
  )

  # Pull the list of services the unified compose file actually defines.
  # docker compose config --services is the authoritative answer; if it
  # fails (e.g. compose can't parse the file) we skip this check rather
  # than block the deploy on a secondary signal.
  local available_services
  if ! available_services=$(dc config --services 2>/dev/null); then
    dstatus envmigrate status=skipped reason=compose-config-failed
    dwarn "Could not list compose services — skipping .env migration check"
    return 0
  fi

  # Auto-yes (set by --auto-yes / -AutoYes from the PS1 wrapper) accepts every
  # suggested migration without prompting. Otherwise prompt only on a real TTY.
  local interactive=0
  if [ "${AUTO_YES:-0}" = "1" ]; then
    interactive=2  # auto-accept
  elif [ -t 0 ]; then
    interactive=1
  fi

  local migrated=0 flagged=0
  local key
  for key in "${service_vars[@]}"; do
    local current="${!key:-}"
    [ -z "$current" ] && continue
    # If the current value is a real service, nothing to do.
    if grep -qx "$current" <<< "$available_services"; then
      continue
    fi

    flagged=$((flagged + 1))
    local target="${preferred[$key]}"
    # If the preferred replacement isn't a real service either, pick the
    # first available service as a last-resort suggestion.
    if ! grep -qx "$target" <<< "$available_services"; then
      target=$(head -n1 <<< "$available_services")
    fi

    # In auto-yes mode the per-key chatter is informational only (status
    # line still records the migration); demote to dinfo so quiet mode
    # stays quiet. Otherwise the operator needs to see it — use dwarn.
    local _say
    if [ "$interactive" = "2" ]; then _say=dinfo; else _say=dwarn; fi
    $_say "$key='$current' is not a service in $COMPOSE_FILE"
    $_say "  available services: $(tr '\n' ' ' <<< "$available_services")"
    $_say "  suggested value: '$target'"

    local do_update=0
    case "$interactive" in
      2)  # --auto-yes: accept without prompting
        dinfo "  auto-accepting (--auto-yes): $key → '$target'"
        do_update=1
        ;;
      1)  # interactive TTY: prompt
        printf "  Update %s to '%s' in %s? [Y/n] " "$key" "$target" "$ENV_FILE"
        local reply
        read -r reply
        case "$reply" in
          ''|y|Y|yes|YES) do_update=1 ;;
        esac
        ;;
      *)  # non-interactive, no auto-yes: warn and leave alone
        dwarn "  non-interactive run — set $key=$target in $ENV_FILE before re-running (or pass --auto-yes)"
        ;;
    esac

    if [ "$do_update" = "1" ]; then
      if grep -qE "^${key}=" "$ENV_FILE"; then
        sed -i "s|^${key}=.*|${key}=${target}|" "$ENV_FILE"
      else
        printf '%s=%s\n' "$key" "$target" >> "$ENV_FILE"
      fi
      export "$key=$target"
      migrated=$((migrated + 1))
      dok "  $key updated to '$target'"
    fi
  done

  if [ "$flagged" -eq 0 ]; then
    dstatus envmigrate status=ok flagged=0
    dok "No outdated .env values detected"
  else
    dstatus envmigrate status=migrated flagged="$flagged" migrated="$migrated"
    if [ "$migrated" -lt "$flagged" ]; then
      dwarn "$((flagged - migrated)) outdated value(s) left in place — deploy will likely fail downstream."
    fi
  fi
}

# Interactively prompt the operator for any REQUIRED_VARS that are still empty or
# contain placeholder values. Only runs when stdin is a TTY (not in CI or piped
# deploys). Writes updated values directly to ENV_FILE so validate_env sees them.
prompt_missing_vars() {
  # Skip entirely if not interactive — piped/CI runs get a clear error from validate_env
  if [ ! -t 0 ]; then
    return 0
  fi

  local needs_reload=0

  for var in "${REQUIRED_VARS[@]}"; do
    local value="${!var:-}"
    local is_placeholder=0

    if [ -z "$value" ]; then
      is_placeholder=1
    else
      for pattern in "${PLACEHOLDER_PATTERNS[@]}"; do
        if [[ "$value" == *"$pattern"* ]]; then
          is_placeholder=1
          break
        fi
      done
    fi

    if [ "$is_placeholder" = "1" ]; then
      dwarn "$var is not set or still contains a placeholder value."
      printf "  Enter value for %s: " "$var"
      local new_val
      read -r new_val
      if [ -n "$new_val" ]; then
        # Update or append KEY=VALUE in ENV_FILE
        if grep -qE "^${var}=" "$ENV_FILE" 2>/dev/null; then
          sed -i "s|^${var}=.*|${var}=${new_val}|" "$ENV_FILE"
        else
          echo "${var}=${new_val}" >> "$ENV_FILE"
        fi
        export "${var}=${new_val}"
        needs_reload=1
        dok "$var updated."
      else
        dwarn "$var left unchanged — validate_env may fail."
      fi
    fi
  done

  if [ "$needs_reload" = "1" ]; then
    dinfo "Reloading .env after interactive updates..."
    load_env
  fi
}
