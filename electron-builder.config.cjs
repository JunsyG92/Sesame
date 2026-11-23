// @ts-check
'use strict';
/**
 * electron-builder configuration.
 *
 * - Linux: AppImage, deb, rpm — Windows: NSIS installer + portable — macOS: universal dmg + zip.
 * - Signing and notarisation only happen when their secrets are present (CSC_LINK /
 *   CSC_KEY_PASSWORD, WIN_CSC_LINK, APPLE_API_KEY… or APPLE_ID…): without them the
 *   build still succeeds and produces unsigned installers.
 * - The auto-update feed is the GitHub release of the repository the build runs for
 *   (GITHUB_REPOSITORY in CI, or the "repository" field of package.json). Without
 *   either, the update feed is omitted and the app simply never finds updates.
 */
const pkg = require('./package.json');

function githubRepository() {
  const fromCi = process.env.GITHUB_REPOSITORY;
  const fromPackage =
    typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
  const match = /([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(fromCi || fromPackage || '');
  return match ? { owner: match[1], repo: match[2] } : null;
}

const repository = githubRepository();

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'org.sesame.passwordmanager',
  productName: 'Sesame',
  copyright: 'Copyright © Sesame contributors',
  directories: {
    output: 'dist',
    buildResources: 'build',
  },
  files: ['out/**', 'resources/**', 'package.json', '!**/*.map'],
  asar: true,
  npmRebuild: false,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // Hardened Electron fuses (see SECURITY.md). Pages are loaded from file:// inside
  // the integrity-checked asar, hence grantFileProtocolExtraPrivileges stays on.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: true,
  },
  linux: {
    target: [
      {
        target: 'AppImage',
        arch: ['x64', 'arm64'],
      },
      {
        target: 'deb',
        arch: ['x64', 'arm64'],
      },
      {
        target: 'rpm',
        arch: ['x64', 'arm64'],
      },
    ],
    executableName: 'sesame',
    category: 'Utility',
    icon: 'build/icon.png',
    synopsis: 'Password manager compatible with pass',
    description: 'Spotlight-like front-end for the standard Unix password store (pass).',
    desktop: {
      entry: {
        Name: 'Sesame',
        Keywords: 'password;pass;gpg;',
        StartupWMClass: 'Sesame',
      },
    },
  },
  deb: {
    recommends: ['gnupg', 'git', 'pinentry-gnome3'],
  },
  rpm: {
    fpm: ['--rpm-rpmbuild-define=_build_id_links none'],
  },
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64', 'arm64'],
      },
      {
        target: 'portable',
        arch: ['x64', 'arm64'],
      },
    ],
    icon: 'build/icon.png',
    executableName: 'Sesame',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
  },
  portable: {
    artifactName: '${productName}-Portable-${version}-${arch}.${ext}',
  },
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['universal'],
      },
      {
        target: 'zip',
        arch: ['universal'],
      },
    ],
    category: 'public.app-category.utilities',
    icon: 'build/icon.png',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // LSUIElement: launcher app without a Dock icon until the manager window opens.
    extendInfo: {
      LSUIElement: true,
      NSScreenCaptureUsageDescription:
        'Sesame scans the screen only when you ask it to import a one-time-code QR code.',
    },
  },
  dmg: {
    sign: false,
  },
  publish: repository ? [{ provider: 'github', releaseType: 'release', ...repository }] : null,
};
