import express from 'express';
import { AI_PROVIDERS, ROUTE_POLICY, configuredProviders } from './ai-provider-registry.mjs';

const appPrototype = express.application;
const originalGet = appPrototype.get;

function safeProvider(p) {
  return { id:p.id, name:p.name, class:p.class, configured:p.configured, capabilities:p.capabilities, priority:p.priority };
}

function buildStatus() {
  const providers = configuredProviders(process.env).map(safeProvider);
  const configured = providers.filter(p => p.configured);
  const capabilities = {};
  for (const [capability, ids] of Object.entries(ROUTE_POLICY)) {
    capabilities[capability] = ids.map(id => providers.find(p => p.id === id)).filter(Boolean).map(p => ({ id:p.id, name:p.name, configured:p.configured }));
  }
  return {
    ok:true,
    service:'SQ AI',
    strategy:'free-first with automatic provider fallback',
    configured_provider_count:configured.length,
    provider_count:providers.length,
    providers,
    capabilities
  };
}

if (!appPrototype.__sqAiStatusRoutes) {
  appPrototype.__sqAiStatusRoutes = true;
  const originalListen = appPrototype.listen;
  appPrototype.listen = function (...args) {
    const app = this;
    if (!app.__sqAiStatusRoutesRegistered) {
      app.__sqAiStatusRoutesRegistered = true;
      originalGet.call(app, '/api/ai/status', (_req,res) => res.json(buildStatus()));
      originalGet.call(app, '/api/ai/capabilities', (_req,res) => res.json({ok:true, capabilities:ROUTE_POLICY}));
    }
    return originalListen.apply(this,args);
  };
}
