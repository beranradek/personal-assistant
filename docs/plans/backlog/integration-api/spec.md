For GMail and Calendar, I want to build "integ-api", central API for personal assistant proxying integrated services (like GMail,    
Calendar and others in the future), so I can implement security guardrails/filtering/anonymizing sensitive content into this proxy api layer  
and also only this programmatic integration api layer will then need access to real authentication secrets (keys, API keys, OAuth data,       
...) so the AI assistant layer will (and should) not have access to these sensitive secrets, right? I also want to build simple "pa           
integapi" (personal agent integration API) CLI facing the personal assistant/facade for personal assistant so he can call/query some          
services on demand.

Ok, but for GMail and Calendar, I want to build "integ-api", central API for personal assistant proxying integrated services (like GMail,
Calendar and others in the future), so I can implement security guardrails/filtering/anonymizing sensitive content into this proxy api layer
and also only this programmatic integration api layer will then need access to real authentication secrets (keys, API keys, OAuth data,
...) so the AI assistant layer will (and should) not have access to these sensitive secrets, right? I also want to build simple "pa
integapi" (personal agent integration API) CLI facing the personal assistant/facade for personal assistant so he can call/query some
services on demand. Look at original ~/dev/openclaw project (openclaw personal assistant) how he solved the similar integrations and if my   
approach is good enough, worse or superior, or how we can benefit further from this inspiration.

I want also these functionalities: 
1. Auth profile rotation/fallback — If a Google token expires mid-heartbeat, retry with refresh. Don't just
fail. 
2. Tool discovery — pa integapi list should enumerate available integrations and their capabilities, so the agent knows what it can      
query.
3. Rate limit awareness — OpenClaw tracks provider cooldowns. Your proxy should return structured errors ("rate limited, retry after X") not  
   raw API errors.  Also implement rate limiter on the integ-api itself. And of course our integration can be also packaged by feature/modular,  
   but in final architecture connected to the integ-api. Revert my integration-api/spec.md file and write it all to assistant-improvements/spec.md
   that we will execute.