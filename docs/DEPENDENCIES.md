# Dependency Management

Guidelines for adding, updating, and maintaining project dependencies.

---

## Principles

1. **Latest stable versions** — Always use the latest stable release
2. **Minimal dependencies** — Only add what's necessary
3. **Security first** — No known vulnerabilities
4. **Deliberate updates** — Never auto-pin outdated versions

---

## Adding a New Dependency

### Before adding

1. Check if functionality already exists in current dependencies
2. Research the package:
   - Is it actively maintained?
   - Does it have good test coverage?
   - What's the maintenance status / GitHub activity?
3. Verify the latest stable version: `npm outdated <package>`

### Adding the package

```powershell
npm install package@latest      # Install latest stable version
npm audit                       # Verify no vulnerabilities
git add package.json package-lock.json
git commit -m "chore(deps): add package@latest

Justification: [brief explanation of why this dependency is needed]"
```

**Always use caret ranges** in package.json:
- ✅ `^1.2.3` — Allows minor and patch updates (safe for breaking changes)
- ❌ `1.2.3` — Pinned to exact version (prevents updates)
- ❌ `*` — Any version (unpredictable)

---

## Updating Dependencies

### Manual updates

When updating a dependency:

```powershell
npm update package              # Update to latest compatible version
npm audit                       # Check for vulnerabilities
. scripts\dev\dev-local.ps1 test  # Run full test suite inside Docker container
git add package.json package-lock.json
git commit -m "chore(deps): update package to X.Y.Z"
```

> ⚠️ Tests run inside the Docker container — do not run `npm test` directly on your local machine. Use `. scripts\dev\dev-local.ps1 test` instead.

### Dependabot PRs

Dependabot automatically suggests dependency updates:

1. **Review the PR** — Check the changelog for breaking changes
2. **Run tests** — Ensure all tests pass: `. scripts\dev\dev-local.ps1 test`
3. **Merge when ready** — Use auto-merge or manual merge

**Major version updates** require:
- ✅ Full test suite passing
- ✅ Manual testing of affected features
- ✅ Review of breaking change documentation
- ✅ Explicit approval before merge

**Minor/patch updates** can merge faster:
- ✅ Tests passing
- ✅ Quick skim of changelog
- ✅ No manual testing usually needed

---

## Version Pinning Strategy

| Scenario | Strategy | Example |
|----------|----------|---------|
| Production dependency | Caret range | `^4.1.5` (allows 4.1.6, 4.2.0, etc.) |
| Dev/test tool | Caret range | `^2.1.0` |
| Experimental package | Pin major only | `^0.5.0` (0.x versions are unstable) |
| Security patch critical | Consider pinning | `4.1.5` (after major update stability issues) |

---

## Removing Unused Dependencies

When removing a dependency:

```powershell
npm uninstall package
npm audit                       # Ensure no orphaned deps
git add package.json package-lock.json
git commit -m "chore(deps): remove unused package"
```

---

## Security

- Run `npm audit` regularly — treat vulnerabilities as blockers
- Enable Dependabot alerts in GitHub settings
- High-severity vulnerabilities must be patched within 24 hours
- Never commit `.npmrc` or credentials files
