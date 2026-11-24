# Biometric unlock

Users who are already logged in can open the app with a fingerprint, Face ID or the phone's screen lock.
They turn it on under **My account → Biometric unlock**. The password stays the real login.

## How it works

| Where | What is checked | Where the session is kept |
|---|---|---|
| Store app (Capacitor) | The OS prompt (`capacitor-native-biometric`) | Supabase refresh token in iOS Keychain / Android Keystore. It is refreshed whenever Supabase rotates it. |
| Browser / home-screen app | WebAuthn platform authenticator, on this device only | Normal Supabase session in the browser |

- The app locks when it opens, and again after it was in the background for 60 seconds.
- **Use password instead** on the lock screen turns the feature off and logs the user out.
- Log out and **Delete my account** also turn it off and delete the stored token.
- No biometric data is ever seen by the app or the server.

## Limits (read before relying on it)

- In the **browser** the check is not verified by a server. It is a lock screen for a shared or borrowed phone. Someone who can read the browser's storage can bypass it. For real protection use the store app.
- It only unlocks a session that was created on this phone. A new phone still needs the password, so a "Forgot password" flow is still needed.
- If the user adds a new fingerprint or Face ID, iOS/Android may refuse the stored token. The user then taps **Use password instead** and logs in again.
- Support depends on the phone: no screen lock set up means the toggle is hidden.

## Store app setup (once per machine)

```
npm install
npx cap sync android     # and/or: npx cap sync ios
```

- **iOS:** add to `ios/App/App/Info.plist`:
  `NSFaceIDUsageDescription` = `Aarambh uses Face ID to unlock the app.`
- **Android:** add to `android/app/src/main/AndroidManifest.xml`:
  `<uses-permission android:name="android.permission.USE_BIOMETRIC" />`
- Rebuild and test on a real phone. Simulators and emulators need a fingerprint / Face ID enrolled.

## Test checklist

1. Log in, open **My account**, turn on Biometric unlock, and approve the prompt.
2. Close and reopen the app. The lock screen appears and the prompt opens.
3. Cancel the prompt, then tap **Unlock** and approve. The app opens.
4. Background the app for over a minute, then reopen. It locks again.
5. Tap **Use password instead**. You are logged out and the toggle is off after the next login.
6. Log out from the menu, log in as someone else, and confirm there is no lock screen.
7. Turn the toggle off and confirm the lock screen no longer appears.
