!macro customInit
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 done
    DetailPrint "Requesting running ${PRODUCT_NAME} to exit..."
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-update' $0
    Sleep 1200
  done:
!macroend

!macro customCheckAppRunning
  DetailPrint "Closing running ${PRODUCT_NAME} processes before update..."
  nsExec::ExecToLog `%SYSTEMROOT%\System32\cmd.exe /c taskkill /im "${APP_EXECUTABLE_FILENAME}" /t /fi "USERNAME eq %USERNAME%"`
  Sleep 1000
  nsExec::ExecToLog `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t /fi "USERNAME eq %USERNAME%"`
  Sleep 1000
!macroend
