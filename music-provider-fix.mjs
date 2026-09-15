import express from 'express';

// Music generation is optional. Keep this module syntax-safe and let the
// main media runtime handle music when a configured provider is available.
if (!express.application.__sqaiMusicProviderFix) {
  express.application.__sqaiMusicProviderFix = true;
}

console.log('SQ AI Music Provider Fix loaded');
