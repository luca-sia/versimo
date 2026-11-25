# Contributing

Thanks for helping. The aim of this library is to stay small, with no runtime dependencies. Changes that keep it that way are the easiest to accept.

## Open an issue

Use [GitHub issues](https://github.com/luca-sia/versimo/issues).

- For a bug, say what you did, what you expected and what happened. A short code sample or a record helps a lot. Add the Versimo version and your Node version or browser.
- For an idea, describe the problem first, then your suggestion.
- For a security problem, do not open an issue. Follow [SECURITY.md](SECURITY.md).

Blank issues are fine if the templates do not fit.

## Propose a change

For anything bigger than a small fix, open an issue first so we can agree on the direction before you spend time on it.

## Send a pull request

1. Fork the repository and clone your fork.
2. Create a branch from `main` with a short descriptive name.
3. Run `npm install`.
4. Make your change. Add or update tests in `test/`.
5. Run the checks.

   ```sh
   npm run typecheck
   npm test
   npm run build
   ```

6. Push your branch and open a pull request. Fill in the short template: what, why and how you tested.

Signed-off commits are not required. Keep commits focused and write messages in plain words.

## Other languages

The ports live in `packages/`. Each has its own tests, which read `spec/vectors.json`. A change to the TypeScript behaviour starts with `npm run spec:generate`, then every port has to pass the new vectors. See [docs/porting.md](docs/porting.md).

## Releases

A maintainer bumps `version` in `package.json` and adds a `CHANGELOG.md` entry, then publishes a GitHub release. The release workflow runs the tests and publishes the TypeScript package to npm with provenance, through npm trusted publishing. No token is stored. The other languages are installed from the repository for now.

## Style

- TypeScript, strict mode, ESM. Imports of local files end in `.js`.
- No runtime dependencies. Dev dependencies stay minimal.
- Functions that change records are pure. They return a new record and never change the input.
- Comments only where the code is not obvious.
- Docs use British English and short plain sentences. Please avoid dashes in prose.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
