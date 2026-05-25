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
        },
        onpause:function(){
            isPlaying=false;
            playIcon.textContent='▶';
            playBtn.classList.remove('playing');
            setStatus('Paused','paused');
            stopMetadataFetch();
            stopStallCheck();
        },
        onstop:function(){
            isPlaying=false;
            playIcon.textContent='▶';
            playBtn.classList.remove('playing');
            stopMetadataFetch();
            stopStallCheck();
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
                if(parts.length>=2){
                    artist=parts[0].trim();
                    title=parts.slice(1).join(' - ').trim();
                }
            }

            trackTitle.textContent=title;
            trackArtist.textContent=artist||'—';
        }
    }catch(error){
        console.error('Metadata fetch error:',error);
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
