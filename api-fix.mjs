// Compatibility layer loaded before server.js.
// Keeps the existing frontend video/image tool IDs compatible with backend IDs.
import express from 'express';

const aliases = {
  video_script:'script-video', ad_video:'ad-video', product_video:'product-video', shorts:'reels',
  long_to_shorts:'long-shorts', hooks:'hooks-video',
  image_prompt:'text-image', product_image:'product-image', ad_creative:'ad-creative',
  thumbnail:'thumbnail', background:'background', variations:'variations'
};

const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  if (path === '/api/tools/generate') {
    handlers = handlers.map(handler => {
      if (typeof handler !== 'function') return handler;
      return function sqAiToolCompatibility(req, res, next) {
        if (req.body && typeof req.body === 'object' && aliases[req.body.tool]) {
          req.body.tool = aliases[req.body.tool];
        }
        return handler(req, res, next);
      };
    });
  }
  return originalPost.call(this, path, ...handlers);
};
