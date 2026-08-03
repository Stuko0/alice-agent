;;
;; installer.nsh — Custom NSIS pages for Lydia Desktop installer
;;
;; Included by electron-builder's NSIS template via the `include` directive
;; in package.json (build.nsis.include).
;;
;; Provides:
;;   1. Uninstall prompt: keep ~/.lydia/ data or remove it
;;   2. Protocol handler registration (lydia://) on install
;;   3. Protocol handler cleanup on uninstall
;;

!ifndef LYDIA_INSTALLER_NSH
!define LYDIA_INSTALLER_NSH

; ============================================================================
; Custom Install: register lydia:// protocol handler
; ============================================================================
!macro customInstall
  ; Register the lydia:// protocol handler for deep linking.
  ; This allows web pages and other apps to open lydia:// links.
  WriteRegStr HKLM "Software\Classes\lydia" "" "URL:Lydia Protocol"
  WriteRegStr HKLM "Software\Classes\lydia" "URL Protocol" ""
  WriteRegStr HKLM "Software\Classes\lydia\DefaultIcon" "" "$INSTDIR\Lydia.exe"
  WriteRegStr HKLM "Software\Classes\lydia\shell\open\command" "" '"$INSTDIR\Lydia.exe" "%1"'

  ; Also register per-user (HKCU) for non-admin installs
  WriteRegStr HKCU "Software\Classes\lydia" "" "URL:Lydia Protocol"
  WriteRegStr HKCU "Software\Classes\lydia" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\lydia\DefaultIcon" "" "$INSTDIR\Lydia.exe"
  WriteRegStr HKCU "Software\Classes\lydia\shell\open\command" "" '"$INSTDIR\Lydia.exe" "%1"'

  ; Notify Windows that protocol associations changed
  System::Call 'shell32.dll::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

; ============================================================================
; Custom Uninstall: clean up protocol handler + prompt to keep user data
; ============================================================================
!macro customUnInstall
  ; 1. Remove protocol handler registrations
  DeleteRegKey HKLM "Software\Classes\lydia"
  DeleteRegKey HKCU "Software\Classes\lydia"

  ; 2. Ask the user if they want to keep their Lydia data.
  ;    The installer does NOT remove $PROFILE\.lydia by default — we want to
  ;    give the user a chance to reconsider before deleting chat history,
  ;    skills, API keys, and configuration.
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Do you want to keep your Lydia data?$\r$\n$\r$\n\
     This includes:$\r$\n\
     • Chat history and sessions$\r$\n\
     • Skills and custom tools$\r$\n\
     • Configuration and API keys$\r$\n$\r$\n\
     Keep data for a future reinstall?" \
    /SD IDYES IDYES keep_lydia_data IDNO remove_lydia_data

  remove_lydia_data:
    RMDir /r "$PROFILE\.lydia"
    Goto lydia_data_done

  keep_lydia_data:
    ; Leave .lydia intact
    Goto lydia_data_done

  lydia_data_done:

  ; 3. Notify Windows that protocol associations changed
  System::Call 'shell32.dll::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!endif ; LYDIA_INSTALLER_NSH
