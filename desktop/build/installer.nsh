!macro customCheckAppRunning
  ; Never launch the installed executable from the installer. Older releases can
  ; persist empty startup state when invoked only to request an update shutdown.
  DetailPrint "Closing running ${PRODUCT_NAME} processes before update..."
  nsExec::ExecToLog `%SYSTEMROOT%\System32\cmd.exe /c taskkill /im "${APP_EXECUTABLE_FILENAME}" /t /fi "USERNAME eq %USERNAME%"`
  Sleep 1000
  nsExec::ExecToLog `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t /fi "USERNAME eq %USERNAME%"`
  Sleep 1000
!macroend
