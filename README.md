# Interactive Counter 

<img width="340" height="97" alt="image" src="https://github.com/user-attachments/assets/e83e9b85-364b-48fb-b6e0-3d697de2a92e" />

Compact inline counters for Obsidian notes.

`Counter` turns markdown tokens like `<day-3/10>` into interactive counters in both Live Preview and Reading View.

## Features 🫆

- Inline counters rendered from `<day-current/goal>` tokens
- Edit both the current value and goal directly from the note
- Works in Live Preview and Reading View
- Insert a counter from the command palette or editor context menu
- Customize border radius, border width, border color, background, and counter size from plugin settings

## Usage

Write a token like this in your note:

```md
<day-3/10>
```

It will render as an interactive counter.

- Click the left number to edit the current value
- Click the right number to edit the goal
- Changes are written back to the original markdown token

## Commands

- `Insert counter`

If text like `3/10` is selected, the command converts it into `<day-3/10>`.

## Settings

You can customize:

- Border radius
- Border stroke
- Border color
- Background mode and color
- Counter size

## Privacy

This plugin does not make network requests, send analytics, or use external services.

## Author

- X: [@teorikup](https://x.com/teorikup)
