# Antigravity VS Code Chat Provider

This extension registers a LanguageModelChatProvider for Antigravity so the models show up in Copilot Chat.

## Usage

1. Run `Antigravity: Sign In` from the Command Palette.
2. Open Copilot Chat and select an Antigravity model from the model picker.

The extension stores tokens in VS Code SecretStorage and refreshes them automatically.

## Notes

- OAuth uses `http://localhost:51121/oauth-callback` for the local redirect.
- Antigravity models use the `antigravity-` prefix for quota routing.
- Gemini CLI models use the `-preview` suffix.
