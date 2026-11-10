import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Group, Computer, ChatBubble, Database, RefreshDouble, LogOut, Search, NavArrowRight, NavArrowLeft, Pause, Play, Prohibition, Trash, ArrowDown, ArrowUp } from 'iconoir-react';
import './style.css';
import './admin-danger.css';
import { Modal } from './Modal.jsx';

const number=(v)=>new Intl.NumberFormat('zh-CN').format(Number(v)||0);
const bytes=(v)=>{let n=Number(v)||0;const units=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<4){n/=1024;i++;}return `${n.toFixed(i?1:0)} ${units[i]}`;};
const time=(v)=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—';
const labels={active:'正常',paused:'已暂停',banned:'已封禁',deleted:'已删除'};
function App(){
    const [auth,setAuth]=useState(()=>JSON.parse(sessionStorage.getItem('cerebr-admin-session')||'null'));
    const [username,setUsername]=useState(''),[password,setPassword]=useState('');
    const [page,setPage]=useState('overview'),[overview,setOverview]=useState(null),[users,setUsers]=useState({users:[],total:0,page:0}),[search,setSearch]=useState(''),[index,setIndex]=useState(0);
    const [detail,setDetail]=useState(null),[audit,setAudit]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(null),[deleteName,setDeleteName]=useState('');
    const request=async(path,options={})=>{
        const response=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${auth.token}`}:{})}});
        const result=await response.json();
        if(response.status===401){sessionStorage.removeItem('cerebr-admin-session');setAuth(null);}
        if(!response.ok)throw new Error(result.error||'请求失败');return result;
    };
    const refresh=async()=>{
        if(!auth)return;
        try{
            const [summary,list,log]=await Promise.all([request('/admin/dashboard'),request(`/admin/users?search=${encodeURIComponent(search)}&page=${index}`),request('/admin/audit')]);
            setOverview(summary);setUsers(list);setAudit(log.events);setError('');
            if(index>0&&!list.users.length)setIndex(Math.max(0,Math.ceil(list.total/50)-1));
        }catch(e){setError(e.message);}
    };
    useEffect(()=>{if(!auth)return;void refresh();const timer=setInterval(refresh,15000);return()=>clearInterval(timer);},[auth,search,index]);
    const login=async(event)=>{
        event.preventDefault();setBusy(true);setError('');
        try{const result=await request('/auth/login',{method:'POST',body:JSON.stringify({username,password})});if(result.user.role!=='admin')throw new Error('此账号没有后台管理权限。');sessionStorage.setItem('cerebr-admin-session',JSON.stringify(result));setAuth(result);setPassword('');}catch(e){setError(e.message);}finally{setBusy(false);}
    };
    const confirmAction=(value)=>{setError('');setDeleteName('');setConfirm(value);};
    const cancelAction=()=>{if(!busy){setConfirm(null);setError('');setDeleteName('');}};
    const applyUserAction=async()=>{
        if(!confirm||busy)return;
        if(confirm.action==='delete'&&deleteName!==confirm.user.username){setError('请输入完全一致的用户名以确认删除。');return;}
        setBusy(true);setError('');
        try{
            const deleting=confirm.action==='delete';
            await request(`/admin/users/${confirm.user.id}`,{method:deleting?'DELETE':'PATCH',body:JSON.stringify(deleting?{username:confirm.user.username}:{status:confirm.status})});
            if(deleting&&detail?.id===confirm.user.id)setDetail(null);
            setConfirm(null);await refresh();
        }catch(e){setError(e.message);}finally{setBusy(false);}
    };
    if(!auth)return <main className="login-shell"><div className="login-brand"><span className="brand-mark">c</span><span>Cerebr <small>SYNC CONSOLE</small></span></div><form className="login-card" onSubmit={login}><span className="eyebrow">管理控制台</span><h1>一处查看，<br/>每一端的连接。</h1><p>登录以查看同步状态、管理用户与用量。</p><label>用户名<input autoComplete="username" autoFocus value={username} onChange={e=>setUsername(e.target.value)} required/></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>{error&&<p role="alert" className="error">{error}</p>}<button className="primary" disabled={busy}>{busy?'正在登录…':'登录管理后台'}<NavArrowRight/></button><div className="login-foot">Cerebr · 让对话随你而行</div></form></main>;
    const cards=overview?[
        ['注册用户',number(overview.users.total),<Group/>,`${overview.users.active} 正常 · ${overview.users.paused} 暂停 · ${overview.users.banned} 封禁`],
        ['在线客户端',number(overview.clients.online),<Computer/>,`累计 ${number(overview.clients.total)} 个客户端`],
        ['对话与消息',number(overview.records.chats),<ChatBubble/>,`${number(overview.records.messages)} 条消息`],
        ['同步数据',bytes(overview.records.storage_bytes),<Database/>,`累计传输 ${bytes(Number(overview.traffic.bytes_in)+Number(overview.traffic.bytes_out))}`],
    ]:[];
    return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">c</span><strong>Cerebr</strong><span className="small-badge">Sync</span></div><div className="sidebar-label">工作空间</div><nav>{[['overview','仪表盘',Activity],['users','用户与客户端',Group],['audit','操作记录',Database]].map(([id,label,I])=><button className={page===id?'selected':''} key={id} onClick={()=>setPage(id)}><I/>{label}</button>)}</nav><div className="sidebar-bottom"><span className="avatar">{auth.user.username[0].toUpperCase()}</span><div><strong>{auth.user.username}</strong><small>管理员</small></div><button title="退出登录" onClick={async()=>{try{await request('/auth/logout',{method:'POST'});}finally{sessionStorage.removeItem('cerebr-admin-session');setAuth(null);}}}><LogOut/></button></div></aside><main className="main"><header><div><span className="eyebrow">CEREBR / 同步管理</span><h1>{page==='overview'?'同步概览':page==='users'?'用户与客户端':'操作记录'}</h1><p>{page==='overview'?'所有对话，在各端之间持续流动。':page==='users'?'查看连接、同步规模与用户状态。':'管理员的状态变更与执行时间。'}</p></div><button className="subtle" onClick={refresh}><RefreshDouble/>刷新</button></header>{error&&<div className="error banner" role="alert">{error}</div>}
    {page==='overview'&&<><div className="metric-grid">{cards.map(([label,value,icon,note])=><section className="metric" key={label}><div className="metric-label">{label}{icon}</div><strong>{value}</strong><small>{note}</small></section>)}</div><div className="overview-grid"><section className="panel"><div className="panel-heading"><div><h2>传输流量</h2><p>近 30 天 · 应用层上传与下载字节数</p></div><span className="live-dot">实时更新</span></div><div className="traffic-totals"><span><ArrowUp/>上传 <strong>{bytes(overview?.traffic.bytes_in)}</strong></span><span><ArrowDown/>下载 <strong>{bytes(overview?.traffic.bytes_out)}</strong></span></div><div className="chart">{Array.from({length:30},(_,i)=>{const date=new Date();date.setUTCDate(date.getUTCDate()-29+i);const key=date.toISOString().slice(0,10),row=overview?.series.find(r=>r.day.slice(0,10)===key);const value=Number(row?.bytes_in||0)+Number(row?.bytes_out||0);const max=Math.max(1,...(overview?.series||[]).map(r=>Number(r.bytes_in)+Number(r.bytes_out)));return <div className="chart-column" key={key} title={`${key} · ${bytes(value)}`}><div style={{height:`${value?Math.max(3,value/max*100):2}%`}}/></div>;})}</div><div className="chart-labels"><span>30 天前</span><span>今天</span></div></section><section className="panel status-panel"><h2>服务状态</h2><div className="service-health"><span className="health-ring"><Activity/></span><h3>同步服务运行中</h3><p>本地先保存，连接后自动同步。</p></div><dl><dt>数据库</dt><dd>PostgreSQL</dd><dt>传输方式</dt><dd>HTTPS / WebSocket</dd><dt>最近更新</dt><dd>{overview?new Date(overview.updatedAt).toLocaleTimeString():'—'}</dd></dl></section></div><section className="panel"><div className="panel-heading"><div><h2>最近注册用户</h2><p>快速了解每位用户的同步情况</p></div><button className="text-button" onClick={()=>setPage('users')}>查看全部<NavArrowRight/></button></div><UserTable users={users.users.slice(0,6)} bytes={bytes} open={setDetail}/></section></>}
    {page==='users'&&<section className="panel"><div className="panel-heading"><div className="search"><Search/><input aria-label="搜索用户" placeholder="搜索用户名…" value={search} onChange={e=>{setSearch(e.target.value);setIndex(0);}}/></div><span className="muted">{number(users.total)} 位用户</span></div><UserTable users={users.users} bytes={bytes} open={setDetail} actions={(u)=><div className="row-actions"><button title={u.status==='active'?'暂停同步':'恢复同步'} disabled={busy||u.id===auth.user.id} onClick={()=>confirmAction({user:u,status:u.status==='active'?'paused':'active'})}>{u.status==='active'?<Pause/>:<Play/>}</button>{u.status!=='banned'&&<button title="封禁账号" disabled={busy||u.id===auth.user.id} onClick={()=>confirmAction({user:u,status:'banned'})}><Prohibition/></button>}<button className="danger" title={u.role==='admin'?'不能删除管理员账号':'删除用户'} aria-label={`删除用户 ${u.username}`} disabled={busy||u.role==='admin'} onClick={()=>confirmAction({user:u,action:'delete'})}><Trash/></button></div>}/><div className="pagination"><button disabled={!index} onClick={()=>setIndex(index-1)}><NavArrowLeft/>上一页</button><span>{index+1} / {Math.max(1,Math.ceil(users.total/50))}</span><button disabled={(index+1)*50>=users.total} onClick={()=>setIndex(index+1)}>下一页<NavArrowRight/></button></div></section>}
    {page==='audit'&&<section className="panel table-scroll"><table><thead><tr><th>操作时间</th><th>管理员</th><th>用户</th><th>状态变更</th></tr></thead><tbody>{audit.map((e,i)=><tr key={i}><td>{time(e.created_at)}</td><td>{e.actor}</td><td>{e.username}</td><td><span className={`status ${e.action}`}>{labels[e.action]}</span></td></tr>)}</tbody></table>{!audit.length&&<div className="empty">暂无管理操作</div>}</section>}
    <footer>仅展示同步元数据与用量 · 不读取聊天正文 <span>Cerebr Sync</span></footer></main>
    {detail&&<ClientModal key={detail.id} user={detail} request={request} onClose={()=>setDetail(null)}/>}
    {confirm&&<Modal onClose={cancelAction} aria-labelledby="user-action-title"><span className="eyebrow">用户管理</span><h2 id="user-action-title">{confirm.action==='delete'?'永久删除':confirm.status==='active'?'恢复':confirm.status==='paused'?'暂停':'封禁'} {confirm.user.username}</h2><p>{confirm.action==='delete'?'将永久删除该用户的账号、云端聊天、附件、客户端记录和登录会话，且无法恢复。设备上的本地聊天不会删除。':confirm.status==='active'?'恢复后，客户端可以重新连接并补齐同步。':confirm.status==='paused'?'将断开该用户的同步连接。本地聊天仍可使用，云端数据保留。':'将撤销登录会话并停止同步。用户数据保留，可由管理员恢复。'}</p>{confirm.action==='delete'&&<label className="delete-confirm-label">输入用户名确认删除<input autoComplete="off" value={deleteName} onChange={e=>setDeleteName(e.target.value)} placeholder={confirm.user.username}/></label>}{error&&<p className="error" role="alert">{error}</p>}<div className="modal-actions"><button disabled={busy} onClick={cancelAction}>取消</button><button className={confirm.action==='delete'?'danger danger-primary':'primary'} disabled={busy||confirm.action==='delete'&&deleteName!==confirm.user.username} onClick={applyUserAction}>{busy?'正在处理…':`确认${confirm.action==='delete'?'删除':confirm.status==='active'?'恢复':confirm.status==='paused'?'暂停':'封禁'}`}</button></div></Modal>}</div>;
}
function ClientModal({user,request,onClose}){
    const [devices,setDevices]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
    useEffect(()=>{
        const controller=new AbortController();
        let timer;
        const load=async()=>{
            try{
                const result=await request(`/admin/users/${user.id}/clients`,{signal:controller.signal});
                if(!controller.signal.aborted){setDevices(result.clients);setError('');}
            }catch(e){if(!controller.signal.aborted)setError(e.message);}
            finally{if(!controller.signal.aborted){setLoading(false);timer=setTimeout(load,15000);}}
        };
        void load();
        return()=>{controller.abort();clearTimeout(timer);};
    },[user.id]);
    return <Modal className="wide" onClose={onClose} closeOnBackdrop aria-label="用户客户端">
        <div className="panel-heading"><div><span className="eyebrow">客户端</span><h2>{user.username}</h2></div><button onClick={onClose}>关闭</button></div>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="客户端列表" aria-busy={loading}>
            {error&&<div className="error banner" role="alert">{error}</div>}
            <table><thead><tr><th>客户端</th><th>状态</th><th>对话 / 消息</th><th>上传 / 下载</th><th>最后在线</th></tr></thead><tbody>{devices.map(d=><tr key={d.id}><td><strong>{d.name}</strong><small>{d.platform} · {d.app_version}</small><small>{d.origin}</small></td><td><span className={`status ${d.online?'active':''}`}>{d.online?'在线':'离线'}</span></td><td>{number(d.chats)} / {number(d.messages)}</td><td>{bytes(d.bytes_in)} / {bytes(d.bytes_out)}</td><td>{time(d.last_seen_at)}</td></tr>)}</tbody></table>
            {loading?<div className="empty" role="status">正在读取客户端…</div>:!error&&!devices.length&&<div className="empty">尚未连接同步客户端</div>}
        </div>
    </Modal>;
}
function UserTable({users,open,actions,bytes}){return <div className="table-scroll"><table><thead><tr><th>用户</th><th>状态</th><th>客户端</th><th>对话 / 消息</th><th>数据量</th><th>传输流量</th>{actions&&<th>操作</th>}</tr></thead><tbody>{users.map(u=><tr key={u.id}><td><button className="user-link" onClick={()=>open(u)}><span className="avatar">{u.username[0].toUpperCase()}</span><span><strong>{u.username}</strong><small>{u.role==='admin'?'管理员':'用户'}</small></span></button></td><td><span className={`status ${u.status}`}>{labels[u.status]}</span></td><td><button className="text-button" onClick={()=>open(u)}>{u.onlineClients} 在线 / {u.clients}<NavArrowRight/></button></td><td>{number(u.chats)} / {number(u.messages)}</td><td>{bytes(u.storage_bytes)}</td><td>{bytes(Number(u.bytes_in)+Number(u.bytes_out))}</td>{actions&&<td>{actions(u)}</td>}</tr>)}</tbody></table>{!users.length&&<div className="empty">没有匹配的用户</div>}</div>;}
createRoot(document.getElementById('root')).render(<App/>);
