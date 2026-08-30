;;
;; installer.nsh — Custom NSIS pages for Alice Desktop installer
;;
;; Included by electron-builder's NSIS template via the `include` directive
;; in package.json (build.nsis.include).
;;
;; Provides:
;;   1. Uninstall prompt: keep ~/.alice/ data or remove it
;;   2. Protocol handler registration (alice://) on install
;;   3. Protocol handler cleanup on uninstall
;;

!ifndef ALICE_INSTALLER_NSH
!define ALICE_INSTALLER_NSH

; ============================================================================
; Custom Install: register alice:// protocol handler
; ============================================================================
!macro customInstall
  ; Register the alice:// protocol handler for deep linking.
  ; This allows web pages and other apps to open alice:// links.
  WriteRegStr HKLM "Software\Classes\alice" "" "URL:Alice Protocol"
  WriteRegStr HKLM "Software\Classes\alice" "URL Protocol" ""
  WriteRegStr HKLM "Software\Classes\alice\DefaultIcon" "" "$INSTDIR\Alice.exe"
  WriteRegStr HKLM "Software\Classes\alice\shell\open\command" "" '"$INSTDIR\Alice.exe" "%1"'

  ; Also register per-user (HKCU) for non-admin installs
  WriteRegStr HKCU "Software\Classes\alice" "" "URL:Alice Protocol"
  WriteRegStr HKCU "Software\Classes\alice" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\alice\DefaultIcon" "" "$INSTDIR\Alice.exe"
  WriteRegStr HKCU "Software\Classes\alice\shell\open\command" "" '"$INSTDIR\Alice.exe" "%1"'

  ; Notify Windows that protocol associations changed
  System::Call 'shell32.dll::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

; ============================================================================
; Custom Uninstall: clean up protocol handler + prompt to keep user data
; ============================================================================
!macro customUnInstall
  ; 1. Remove protocol handler registrations
  DeleteRegKey HKLM "Software\Classes\alice"
  DeleteRegKey HKCU "Software\Classes\alice"

  ; 2. Ask the user if they want to keep their Alice data.
  ;    The installer does NOT remove $PROFILE\.alice by default — we want to
  ;    give the user a chance to reconsider before deleting chat history,
  ;    skills, API keys, and configuration.
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Do you want to keep your Alice data?$\r$\n$\r$\n\
     This includes:$\r$\n\
     • Chat history and sessions$\r$\n\
     • Skills and custom tools$\r$\n\
     • Configuration and API keys$\r$\n$\r$\n\
     Keep data for a future reinstall?" \
    /SD IDYES IDYES keep_alice_data IDNO remove_alice_data

  remove_alice_data:
    RMDir /r "$PROFILE\.alice"
    Goto alice_data_done

  keep_alice_data:
    ; Leave .alice intact
    Goto alice_data_done

  alice_data_done:

  ; 3. Notify Windows that protocol associations changed
  System::Call 'shell32.dll::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!endif ; ALICE_INSTALLER_NSH
