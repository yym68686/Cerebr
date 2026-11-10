import { createApp } from './app.js';
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const {app}=await createApp();
await app.listen({host:'0.0.0.0',port:Number(process.env.PORT)||8080});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void app.close().then(()=>process.exit(0)));
