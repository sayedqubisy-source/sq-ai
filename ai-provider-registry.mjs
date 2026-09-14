// SQ AI Provider Registry — public metadata only; secrets stay in environment variables.
export const AI_PROVIDERS = [
  {id:'openrouter',name:'OpenRouter',class:'llm_gateway',env:'OPENROUTER_API_KEY',capabilities:['text','vision','reasoning','tool_use'],priority:100,fallback:['gemini','groq','deepseek']},
  {id:'gemini',name:'Google Gemini',class:'multimodal',env:'GEMINI_API_KEY',capabilities:['text','vision','audio','image','video','music'],priority:98,fallback:['openrouter','groq']},
  {id:'openai',name:'OpenAI',class:'frontier',env:'OPENAI_API_KEY',capabilities:['text','vision','image','audio','embeddings'],priority:97,fallback:['openrouter','gemini']},
  {id:'anthropic',name:'Anthropic',class:'reasoning',env:'ANTHROPIC_API_KEY',capabilities:['text','reasoning','coding'],priority:96,fallback:['openrouter','gemini']},
  {id:'deepseek',name:'DeepSeek',class:'reasoning',env:'DEEPSEEK_API_KEY',capabilities:['text','reasoning','coding'],priority:90,fallback:['openrouter','groq']},
  {id:'groq',name:'Groq',class:'fast_inference',env:'GROQ_API_KEY',capabilities:['text','reasoning','speech'],priority:89,fallback:['openrouter','deepseek']},
  {id:'mistral',name:'Mistral AI',class:'multimodal',env:'MISTRAL_API_KEY',capabilities:['text','vision','ocr','embeddings'],priority:87,fallback:['openrouter','gemini']},
  {id:'cohere',name:'Cohere',class:'enterprise_search',env:'COHERE_API_KEY',capabilities:['text','embeddings','rerank'],priority:80,fallback:['mistral','openrouter']},
  {id:'together',name:'Together AI',class:'open_models',env:'TOGETHER_API_KEY',capabilities:['text','image','embeddings'],priority:78,fallback:['groq','openrouter']},
  {id:'fireworks',name:'Fireworks AI',class:'open_models',env:'FIREWORKS_API_KEY',capabilities:['text','vision','image'],priority:77,fallback:['together','openrouter']},
  {id:'huggingface',name:'Hugging Face',class:'open_models',env:'HF_TOKEN',capabilities:['text','image','video','audio'],priority:75,fallback:['replicate','fal']},
  {id:'replicate',name:'Replicate',class:'model_marketplace',env:'REPLICATE_API_TOKEN',capabilities:['image','video','audio','3d','text'],priority:74,fallback:['fal','huggingface']},
  {id:'fal',name:'fal.ai',class:'media_inference',env:'FAL_KEY',capabilities:['image','video','audio','3d'],priority:73,fallback:['replicate','huggingface']},
  {id:'elevenlabs',name:'ElevenLabs',class:'voice',env:'ELEVENLABS_API_KEY',capabilities:['tts','voice_clone','dubbing'],priority:85,fallback:['deepgram','gemini']},
  {id:'deepgram',name:'Deepgram',class:'speech',env:'DEEPGRAM_API_KEY',capabilities:['stt','tts','voice_agents'],priority:84,fallback:['gemini','elevenlabs']},
  {id:'tavily',name:'Tavily',class:'search',env:'TAVILY_API_KEY',capabilities:['web_search','research'],priority:88,fallback:['brave','exa']},
  {id:'brave',name:'Brave Search',class:'search',env:'BRAVE_SEARCH_API_KEY',capabilities:['web_search'],priority:82,fallback:['tavily','exa']},
  {id:'exa',name:'Exa',class:'neural_search',env:'EXA_API_KEY',capabilities:['web_search','research','similarity'],priority:81,fallback:['tavily','brave']},
  {id:'firecrawl',name:'Firecrawl',class:'web_extraction',env:'FIRECRAWL_API_KEY',capabilities:['crawl','scrape','extract'],priority:86,fallback:['jina','apify']},
  {id:'jina',name:'Jina AI',class:'web_extraction',env:'JINA_API_KEY',capabilities:['reader','embeddings','search'],priority:79,fallback:['firecrawl','tavily']},
  {id:'apify',name:'Apify',class:'automation',env:'APIFY_API_TOKEN',capabilities:['scraping','browser','automation'],priority:76,fallback:['firecrawl']}
];

export const ROUTE_POLICY={
  text:['openrouter','gemini','anthropic','deepseek','groq','mistral','together','fireworks','huggingface'],
  reasoning:['anthropic','openrouter','gemini','deepseek','mistral'],
  coding:['anthropic','openrouter','deepseek','gemini','groq'],
  image:['gemini','fal','replicate','openai','huggingface'],
  video:['gemini','fal','replicate','huggingface'],
  audio:['gemini','elevenlabs','deepgram','huggingface'],
  music:['gemini','huggingface','fal','replicate'],
  tts:['elevenlabs','deepgram','gemini'],
  stt:['deepgram','gemini','elevenlabs'],
  search:['tavily','brave','exa'],
  crawl:['firecrawl','jina','apify']
};

export function configuredProviders(env=process.env){
  return AI_PROVIDERS.map(p=>({...p,configured:Boolean(env[p.env])}));
}
export function chooseProvider(capability,env=process.env){
  for(const id of (ROUTE_POLICY[capability]||ROUTE_POLICY.text)){
    const p=AI_PROVIDERS.find(x=>x.id===id);
    if(p&&env[p.env]) return p;
  }
  return null;
}
export function providerHealth(env=process.env){
  return configuredProviders(env).map(p=>({id:p.id,name:p.name,configured:p.configured,capabilities:p.capabilities,priority:p.priority}));
}
