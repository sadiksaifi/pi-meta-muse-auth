# Releasing

Start from a clean, up-to-date `main` branch.

```bash
npm run check
npm version patch -m "chore(release): %s"

TAG="v$(node --print 'require("./package.json").version')"
git push origin main "$TAG"
```

Use `minor` or `major` instead of `patch` when appropriate. Wait for CI to pass, then publish the GitHub Release:

```bash
TAG="v$(node --print 'require("./package.json").version')"
gh release create "$TAG" --verify-tag --generate-notes --latest --fail-on-no-commits
```

Publishing the GitHub Release triggers the npm workflow. Approve the `npm` deployment in GitHub Actions to continue.
