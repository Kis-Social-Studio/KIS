#!/usr/bin/env bash
set -euo pipefail
umask 077
studio="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
platform="${1:-}"
output="${2:-}"
if [[ ( "$platform" != "ios" && "$platform" != "android" ) || "$output" != /* ]]; then
  echo "Usage : bash mobile/release.sh ios|android /chemin/absolu/nouveau" >&2
  exit 2
fi

if [[ "$platform" == "ios" ]]; then
  : "${IOS_TEAM_ID:?Équipe Apple requise}"
  : "${IOS_PROFILE_NAME:?Profil de distribution installé requis}"
  : "${IOS_EXPORT_OPTIONS_PLIST:?Fichier ExportOptions.plist requis}"
  command -v xcodebuild >/dev/null
  method="$(plutil -extract method raw "$IOS_EXPORT_OPTIONS_PLIST")"
  destination="$(plutil -extract destination raw "$IOS_EXPORT_OPTIONS_PLIST")"
  [[ "$method" == "app-store-connect" && "$destination" == "export" ]] || {
    echo "Export local App Store Connect requis." >&2
    exit 2
  }
  [[ -d "$studio/ios/App/App.xcodeproj" ]]
  mkdir -m 700 "$output"
  cd "$studio/ios/App"
  xcodebuild -project App.xcodeproj -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$output/App.xcarchive" \
    "DEVELOPMENT_TEAM=$IOS_TEAM_ID" CODE_SIGN_STYLE=Manual "PROVISIONING_PROFILE_SPECIFIER=$IOS_PROFILE_NAME" \
    'CODE_SIGN_IDENTITY=Apple Distribution' archive
  xcodebuild -exportArchive -archivePath "$output/App.xcarchive" \
    -exportOptionsPlist "$IOS_EXPORT_OPTIONS_PLIST" -exportPath "$output/export"
  compgen -G "$output/export/*.ipa" >/dev/null
else
  : "${ANDROID_UPLOAD_KEYSTORE:?Keystore de téléversement requis}"
  : "${ANDROID_UPLOAD_ALIAS:?Alias de téléversement requis}"
  : "${ANDROID_UPLOAD_STOREPASS:?Mot de passe du keystore requis}"
  : "${ANDROID_UPLOAD_KEYPASS:?Mot de passe de la clé requis}"
  : "${ANDROID_UPLOAD_SHA256:?Empreinte SHA-256 de la clé de téléversement requise}"
  [[ "$ANDROID_UPLOAD_KEYSTORE" == /* && -r "$ANDROID_UPLOAD_KEYSTORE" ]]
  [[ -f "$studio/android/gradlew" ]]
  command -v jarsigner >/dev/null
  command -v keytool >/dev/null
  mkdir -m 700 "$output"
  cd "$studio/android"
  bash ./gradlew --no-daemon :app:bundleRelease
  unsigned="$studio/android/app/build/outputs/bundle/release/app-release.aab"
  bundle="$output/app-release.aab"
  jarsigner -keystore "$ANDROID_UPLOAD_KEYSTORE" -storepass:env ANDROID_UPLOAD_STOREPASS \
    -keypass:env ANDROID_UPLOAD_KEYPASS -signedjar "$bundle" "$unsigned" "$ANDROID_UPLOAD_ALIAS"
  verification="$(LC_ALL=C jarsigner -J-Duser.language=en -verify "$bundle")"
  grep -Fq 'jar verified.' <<< "$verification"
  fingerprint="$(keytool -J-Duser.language=en -printcert -jarfile "$bundle" |
    awk '/SHA256:/ && !found {print $2; found=1}' | tr -d ':')"
  expected="$(printf '%s' "$ANDROID_UPLOAD_SHA256" | tr -d ':' | tr '[:lower:]' '[:upper:]')"
  [[ "$expected" =~ ^[A-F0-9]{64}$ && "$fingerprint" == "$expected" ]] || {
    echo "Empreinte de la signature Android inattendue. Conserver le fichier pour contrôle." >&2
    exit 1
  }
fi
