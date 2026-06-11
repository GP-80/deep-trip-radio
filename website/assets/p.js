// Deep Trip Radio Player with Howler.js
(function(){
const playBtn=document.getElementById('b'),
playIcon=document.getElementById('c'),
statusDisplay=document.getElementById('d'),
statusText=document.getElementById('e'),
volumeSlider=document.getElementById('f'),
trackTitle=document.getElementById('g'),
trackArtist=document.getElementById('h'),
muteBtn=document.getElementById('i'),
muteIcon=document.getElementById('j');

const STREAM_URL='https://stream.deeptripradio.net/live';
const METADATA_URL='https://stream.deeptripradio.net/status-json.xsl';
const NOW_URL='https://stream.deeptripradio.net/api/now';
const COVER_URL='https://stream.deeptripradio.net/api/cover';
const PING_URL='https://stream.deeptripradio.net/api/listener-ping';

function ccUrl(label){const m=label.match(/^CC\s+([A-Z-]+)\s+([\d.]+)$/i);return m?'https://creativecommons.org/licenses/'+m[1].toLowerCase()+'/'+m[2]+'/':'';}

const coverImg=document.getElementById('album-cover');
const albumLinkContainer=document.getElementById('album-link-container');
const albumLink=document.getElementById('album-link');
const licenseInfo=document.getElementById('license-info');
const licenseLink=document.getElementById('license-link');

let pingInterval=null;
function pingListener(){fetch(PING_URL,{cache:'no-cache'}).catch(()=>{});}
function startPing(){pingListener();pingInterval=setInterval(pingListener,60000);}
function stopPing(){if(pingInterval){clearInterval(pingInterval);pingInterval=null;}}

let sound=null;
let isPlaying=false;
let isMuted=false;
let savedVolume=80;
let metadataInterval=null;
let userPaused=false;
let reconnectAttempts=0;
let reconnectTimer=null;
const MAX_RECONNECT=20;
let stallCheckInterval=null;
let lastSeekTime=-1;
let currentTrackKey=null;

function loadVolume(){
    const saved=localStorage.getItem('dtr_volume');
    console.log('Loading volume from localStorage:', saved);
    if(saved!==null){
        const vol=parseInt(saved,10);
        console.log('Parsed volume:', vol);
        if(vol>=0&&vol<=100){
            savedVolume=vol;
            volumeSlider.value=vol;
            console.log('Set slider to:', vol);
            if(vol===0){
                isMuted=true;
                muteIcon.textContent='○';
                muteBtn.classList.add('muted');
            }
        }
    }else{
        console.log('No saved volume, using default:', savedVolume);
        saveVolume(savedVolume);
        volumeSlider.value=savedVolume;
    }
}

function saveVolume(vol){
    localStorage.setItem('dtr_volume',vol.toString());
}

function startStallCheck(){
    stopStallCheck();
    lastSeekTime=-1;
    stallCheckInterval=setInterval(function(){
        if(!isPlaying||userPaused||!sound)return;
        const t=sound.seek();
        if(typeof t!=='number')return;
        if(lastSeekTime>=0&&t===lastSeekTime){
            console.warn('Stall detected: currentTime frozen at',t,'— reconnecting');
            stopStallCheck();
            stopMetadataFetch();
            if(sound){sound.unload();sound=null;}
            scheduleReconnect();
        }
        lastSeekTime=t;
    },5000);
}

function stopStallCheck(){
    if(stallCheckInterval){clearInterval(stallCheckInterval);stallCheckInterval=null;}
    lastSeekTime=-1;
}

function scheduleReconnect(){
    if(userPaused){
        setStatus('Error','');
        playBtn.classList.remove('connecting','playing');
        playIcon.textContent='▶';
        return;
    }
    if(reconnectAttempts>=MAX_RECONNECT){
        if(sound){sound.unload();sound=null;}
        reconnectAttempts=0;
        setStatus('Error','');
        playBtn.classList.remove('connecting','playing');
        playIcon.textContent='▶';
        return;
    }
    const delay=Math.min(2000*Math.pow(2,reconnectAttempts),30000);
    reconnectAttempts++;
    console.log('Reconnecting in',delay,'ms (attempt',reconnectAttempts,')');
    setStatus('Reconnecting…','connecting');
    playBtn.classList.add('connecting');
    playBtn.classList.remove('playing');
    playIcon.textContent='▶';
    reconnectTimer=setTimeout(()=>{
        if(!userPaused){
            if(sound){sound.unload();sound=null;}
            playStream();
        }
    },delay);
}

function initStream(){
    if(sound){
        sound.unload();
    }

    sound=new Howl({
        src:[STREAM_URL],
        html5:true,
        format:['mp3'],
        volume:savedVolume/100,
        onload:function(){
            console.log('Stream ready');
        },
        onplay:function(){
            isPlaying=true;
            reconnectAttempts=0;
            if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
            playIcon.textContent='❚❚';
            playBtn.classList.add('playing');
            playBtn.classList.remove('connecting');
            setStatus('Live','live');
            startMetadataFetch();
            startStallCheck();
            startPing();
        },
        onpause:function(){
            isPlaying=false;
            playIcon.textContent='▶';
            playBtn.classList.remove('playing');
            setStatus('Paused','paused');
            stopMetadataFetch();
            stopStallCheck();
            stopPing();
        },
        onstop:function(){
            isPlaying=false;
            playIcon.textContent='▶';
            playBtn.classList.remove('playing');
            stopMetadataFetch();
            stopStallCheck();
            stopPing();
            if(!userPaused){
                scheduleReconnect();
            }else{
                setStatus('Stopped','');
            }
        },
        onloaderror:function(id,err){
            console.error('Load error:',err);
            stopMetadataFetch();
            stopStallCheck();
            scheduleReconnect();
        },
        onplayerror:function(id,err){
            console.error('Play error:',err);
            sound.once('unlock',function(){
                sound.play();
            });
        }
    });
}

function setStatus(text,className){
    statusText.textContent=text;
    statusDisplay.className='status-display '+className;
}

function playStream(){
    userPaused=false;
    if(!sound){
        initStream();
    }
    playBtn.classList.add('connecting');
    setStatus('Connecting','connecting');
    sound.play();
}

function pauseStream(){
    userPaused=true;
    reconnectAttempts=0;
    if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
    if(sound){
        sound.pause();
    }
}

function setVolume(vol){
    savedVolume=vol;
    if(sound){
        sound.volume(vol/100);
    }
    saveVolume(vol);

    if(vol>0&&isMuted){
        isMuted=false;
        muteIcon.textContent='♪';
        muteBtn.classList.remove('muted');
    }else if(vol===0&&!isMuted){
        isMuted=true;
        muteIcon.textContent='○';
        muteBtn.classList.add('muted');
    }
}

async function fetchMetadata(){
    let gotRichData=false;
    try{
        const r=await fetch(NOW_URL,{method:'GET',cache:'no-cache'});
        if(r.ok){
            const d=await r.json();
            if(d.title){
                gotRichData=true;
                const key=(d.artist||'')+'||'+d.title;
                trackTitle.textContent=d.title;
                trackArtist.textContent=d.artist||'—';
                if(key!==currentTrackKey){
                    currentTrackKey=key;
                    const wasVisible=coverImg.style.opacity==='1';
                    coverImg.style.opacity='0';
                    const loadCover=()=>{
                        coverImg.onload=()=>{ requestAnimationFrame(()=>{ coverImg.style.opacity='1'; }); };
                        coverImg.onerror=()=>{ coverImg.style.opacity='0'; };
                        coverImg.src=COVER_URL+'?t='+Date.now();
                    };
                    if(wasVisible) setTimeout(loadCover,320); else loadCover();
                }
                if(d.url){ albumLink.href=d.url; albumLinkContainer.style.display=''; }
                else{ albumLinkContainer.style.display='none'; }
                if(d.license){ licenseLink.textContent=d.license; licenseLink.href=ccUrl(d.license); licenseInfo.style.display=''; }
                else{ licenseInfo.style.display='none'; }
            }
        }
    }catch(err){ console.error('Music server error:',err); }
    if(!gotRichData){
        try{
            const response=await fetch(METADATA_URL,{method:'GET',mode:'cors',cache:'no-cache'});
            if(!response.ok)return;
            const data=await response.json();
            if(data.icestats&&data.icestats.source){
                const source=data.icestats.source;
                let title=source.title||'Unknown Track';
                let artist=source.artist||'';
                if(!artist){
                    const parts=title.split(' - ');
                    if(parts.length>=2){ artist=parts[0].trim(); title=parts.slice(1).join(' - ').trim(); }
                }
                trackTitle.textContent=title;
                trackArtist.textContent=artist||'—';
                const icKey=(artist||'')+'||'+title;
                if(icKey!==currentTrackKey&&currentTrackKey!==null){
                    coverImg.style.opacity='0';
                    albumLinkContainer.style.display='none';
                    licenseInfo.style.display='none';
                    currentTrackKey=null;
                }
            }
        }catch(error){ console.error('Metadata fetch error:',error); }
    }
}

function startMetadataFetch(){
    fetchMetadata();
    metadataInterval=setInterval(fetchMetadata,5000);
}

function stopMetadataFetch(){
    if(metadataInterval){
        clearInterval(metadataInterval);
        metadataInterval=null;
    }
}

playBtn.addEventListener('click',()=>{
    if(playBtn.classList.contains('connecting'))return;
    isPlaying?pauseStream():playStream();
});

volumeSlider.addEventListener('input',e=>{
    const vol=parseInt(e.target.value,10);
    setVolume(vol);
});

muteBtn.addEventListener('click',()=>{
    if(isMuted){
        volumeSlider.value=savedVolume;
        setVolume(savedVolume);
    }else{
        const currentVol=parseInt(volumeSlider.value,10)||80;
        savedVolume=currentVol;
        volumeSlider.value=0;
        setVolume(0);
    }
});

document.addEventListener('keydown',e=>{
    if(e.code==='Space'&&e.target.tagName!=='INPUT'){
        e.preventDefault();
        playBtn.click();
    }
});

loadVolume();
setStatus('Ready','');
})();
