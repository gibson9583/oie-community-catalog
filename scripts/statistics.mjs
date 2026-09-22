import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function repository(url) {
    try { const u=new URL(url); return u.protocol==='https:' && u.hostname==='github.com' && /^\/[\w.-]+\/[\w.-]+\/?$/.test(u.pathname) ? u.pathname.replace(/^\//,'').replace(/\/$/,'') : null; } catch {return null;}
}
export function identity(pkg) {
    return JSON.stringify([pkg.repository, [...new Set(pkg.versions.map(v=>v.installerUrl))].sort()]);
}
export function publishedStatistics(pkg, saved) {
    return saved?.identity===identity(pkg) ? saved.metrics : {};
}
function matcher(pkg) {
    const families=[];
    for(const v of pkg.versions) {
        try {
            const u=new URL(v.installerUrl), p=u.pathname.split('/').map(decodeURIComponent);
            if(u.protocol!=='https:' || u.hostname!=='github.com' || p.length!==7 || p[3]!=='releases' || p[4]!=='download' || `${p[1]}/${p[2]}`!==repository(pkg.repository) || !p[6].endsWith('.zip')) continue;
            const at=p[6].indexOf(v.version);
            if(at<=0 || p[6].indexOf(v.version,at+v.version.length)!==-1) continue;
            families.push([p[6].slice(0,at),p[6].slice(at+v.version.length)]);
        } catch { /* Unsupported URL. */ }
    }
    return families.length ? (name,tag)=>families.some(([a,b])=>{
        const stem=a+tag.replace(/^[vV]/,'');
        if(name===stem+b)return true;
        // Count explicitly named OIE compatibility installers, not arbitrary
        // suffixes such as -sources, -javadoc, or another package's archives.
        const compatibility=/^-oie-?[0-9]+(?:\.[0-9]+){1,3}\.zip$/i;
        if(b!=='.zip' && !compatibility.test(b))return false;
        return typeof name==='string' && name.startsWith(stem)
            && (name.slice(stem.length)==='.zip' || compatibility.test(name.slice(stem.length)));
    }) : null;
}
export async function refreshStatistics(packages, previous={}, api, now=new Date().toISOString()) {
    const cache=new Map();
    const get=path=>{if(!cache.has(path))cache.set(path,Promise.resolve().then(()=>api(path)));return cache.get(path);};
    const result={};
    async function pages(path) {
        const all=[];
        for(let page=1;page<=100;page++) {
            const list=await get(`${path}?per_page=100&page=${page}`);
            if(!Array.isArray(list)) throw Error('invalid_response');
            all.push(...list);
            if(list.length<100)return all;
        }
        throw Error('pagination_limit');
    }
    const count=n=>{if(!Number.isSafeInteger(n)||n<0)throw Error('invalid_count');return n;};
    for(const pkg of packages) {
        const repo=repository(pkg.repository), old=publishedStatistics(pkg,previous[pkg.id]);
        const metrics={};
        async function metric(name,work) {
            try {metrics[name]={status:'available',count:count(await work()),checkedAt:now,stale:false};}
            catch {metrics[name]=old[name]?.status==='available' ? {...old[name],stale:true} : {status:'unavailable'};}
        }
        if(repo) {
            await metric('stars',async()=>count((await get(`/repos/${repo}`)).stargazers_count));
            const matches=matcher(pkg);
            if(matches) await metric('downloads',async()=>{
                let total=0, matched=0;const seen=new Set();
                for(const release of await pages(`/repos/${repo}/releases`)) {
                    if(release.draft)continue;
                    if(!Number.isSafeInteger(release.id)||release.id<0||typeof release.tag_name!=='string')throw Error('invalid_release');
                    const assets=Array.isArray(release.assets)&&release.assets.length<30 ? release.assets : await pages(`/repos/${repo}/releases/${release.id}/assets`);
                    for(const asset of assets) {
                        if(!matches(asset.name,release.tag_name))continue;
                        if(!Number.isSafeInteger(asset.id)||asset.id<0)throw Error('invalid_asset');
                        if(seen.has(asset.id))continue;
                        seen.add(asset.id);total=count(total+count(asset.download_count));matched++;
                    }
                }
                if(!matched)throw Error('no_matching_assets');
                return total;
            });
            else metrics.downloads={status:'unavailable'};
        } else {metrics.stars={status:'unavailable'};metrics.downloads={status:'unavailable'};}
        result[pkg.id]={identity:identity(pkg),metrics};
    }
    return result;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
    const index=JSON.parse(readFileSync('index.json','utf8'));
    let previous={};try{previous=JSON.parse(readFileSync('statistics.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    let exhausted=false;
    const api=async path=>{
        if(exhausted)throw Error('rate_limit');
        const r=await fetch('https://api.github.com'+path,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(process.env.GITHUB_TOKEN?{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`}:{})},signal:AbortSignal.timeout(20000),redirect:'error'});
        if(r.status===403||r.status===429)exhausted=true;
        if(!r.ok)throw Error(`GitHub HTTP ${r.status}`);
        return r.json();
    };
    const result=await refreshStatistics(index.packages,previous,api);
    writeFileSync('statistics.json',JSON.stringify(result,null,2)+'\n');
    const stale=Object.values(result).flatMap(v=>Object.values(v.metrics)).filter(m=>m.stale||m.status!=='available').length;
    console.log(`Refreshed ${index.packages.length} packages; ${stale} metrics stale or unavailable (including unsupported sources).`);
}
