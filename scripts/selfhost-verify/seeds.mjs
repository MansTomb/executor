const legacy = `import {defineApp,defineProvider,secrets,object,string,query,mutation} from "apps";
const service=defineProvider({name:"Retained credential",auth:{key:secrets({label:"Token",fields:object({token:string()})})}});
export default defineApp({accounts:{service}},async()=>({queries:{check:query({input:object({})},async ctx=>({retained:ctx.accounts.service.fields.token==="synthetic-upgrade-token"})),seed:query({input:object({})},async ctx=>{await ctx.analytics.emit({event:"upgrade_probe",purpose:"retained"});return true;}),saved:query({input:object({})},async ctx=>ctx.cache.read("drained",string()))},mutations:{hold:mutation({input:object({})},async ctx=>{await new Promise(resolve=>setTimeout(resolve,16000));await ctx.cache.write([{key:"drained",value:"persisted-before-stop"}],"1 hour");return "completed-once";})}}));`;

const router = `import {defineApp,defineProvider,secrets,object,string,query,mutation,router} from "apps";
const service=defineProvider({name:"Retained credential",auth:{key:secrets({label:"Token",fields:object({token:string()})})}});
export default defineApp({accounts:{service}},async ctx=>({tools:router({queries:router({check:query({input:object({})},async()=>({retained:ctx.accounts.service.fields.token==="synthetic-upgrade-token"})),seed:query({input:object({})},async()=>{if(ctx.analytics===undefined)return false;await ctx.analytics.emit({event:"upgrade_probe",purpose:"retained"});return true;}),saved:query({input:object({})},async()=>ctx.cache.read("drained",string()))}),mutations:router({hold:mutation({input:object({})},async()=>{await new Promise(resolve=>setTimeout(resolve,16000));await ctx.cache.write([{key:"drained",value:"persisted-before-stop"}],"1 hour");return "completed-once";})})})}));`;

export const seeds = { legacy, router };
