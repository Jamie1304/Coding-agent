!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Remove Personal Codex Agent local data (settings, run history, and logs)?" IDNO keepData
    RMDir /r "$LOCALAPPDATA\PersonalCodexAgent"
  keepData:
!macroend
