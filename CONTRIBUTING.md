# Contributing

Thanks for your interest in the Pactolis Chart Engine.

- Open an issue to report a bug or propose a change. Pull requests are accepted from
  repository collaborators.
- Run `npm run check`, `npm test` and `npm run check:exports` before sending a change, and `npm run test:browser` when it touches rendering, input or the chart runtime.
- Keep the engine free of runtime dependencies, UI frameworks and browser storage.
  Anything the engine needs from its host goes through a port (see the README).
- Adding or removing an entry under `exports` in `package.json` changes the public API;
  say so in the pull request.
- Only contribute code you wrote yourself or that is available under a license
  compatible with Apache-2.0, and say where any third-party code comes from.

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
