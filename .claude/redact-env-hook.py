#!/usr/bin/env python3
# PreToolUse hook: intercepts Read calls on .env files.
# Mirrors the redact_env function in scripts/deploy/deploy-lib.sh.
# Blocks the real read and injects a redacted version into Claude's context instead.

import json
import os
import re
import sys

data = json.load(sys.stdin)
fp = data.get("tool_input", {}).get("file_path", "")
bn = os.path.basename(fp)

# Only intercept .env and .env.* — leave .env.example templates readable
if not re.match(r"^\.env(\..+)?$", bn) or bn.endswith(".example"):
    sys.exit(0)

sensitive = re.compile(r"SECRET|TOKEN|PASS|KEY|REFRESH|CREDENTIAL|EMAIL|_ID")
lines = []
try:
    with open(fp) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip() or line.strip().startswith("#"):
                lines.append(line)
                continue
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
            if m and sensitive.search(m.group(1)):
                lines.append(m.group(1) + ("=[redacted]" if m.group(2) else "=(empty)"))
            else:
                lines.append(line)
except Exception as e:
    lines = [f"(could not read file: {e})"]

redacted = "\n".join(lines)
out = {
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            f"Direct .env read blocked to prevent secret exposure.\n\n"
            f"Redacted version of {fp} (sensitive values masked):\n\n{redacted}\n\n"
            f"To inspect .env contents safely via bash, use:\n"
            f"  bash -c 'source /home/modnar3/MyPortfolioSite-dev/scripts/deploy/deploy-lib.sh && redact_env {fp}'"
        ),
    }
}
print(json.dumps(out))
