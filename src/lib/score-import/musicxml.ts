import type { ScoreDocument, ScorePage } from '../../types';
import type { ScoreEvent, ScoreReference } from '../score-following/types';
import { createNotation } from '../notation';

interface TabNote { beat: number; duration: number; string: number; fret: number; midi: number; tied: boolean; }
interface Measure { notes: TabNote[]; duration: number; newPage: boolean; number: string; }
interface PlacedMeasure extends Measure { page: number; row: number; startBeat: number; }
const OPEN_STRINGS = [64, 59, 55, 50, 45, 40];
const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const children = (node: Element, name: string) => [...node.children].filter(e => e.localName === name);
const child = (node: Element, name: string) => children(node, name)[0];
const descendants = (node: Element, name: string) => [...node.getElementsByTagNameNS('*', name)];
const text = (node: Element, name: string) => child(node, name)?.textContent?.trim() ?? '';
const numeric = (node: Element, name: string, fallback: number) => {
  const value = text(node, name);
  return value === '' ? fallback : Number(value);
};
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const reject = (message: string): never => { throw new Error(message); };

function parseScore(xml: string): { title: string; measures: Measure[]; tempo: number } {
  if (/<!ENTITY/i.test(xml)) reject('不支持包含自定义实体的 MusicXML。');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) reject('MusicXML 文件不完整。');
  const root = document.documentElement;
  if (root.localName !== 'score-partwise') reject('请上传 score-partwise 格式的 MusicXML。');
  const parts = children(root, 'part');
  if (parts.length !== 1) reject('当前支持单乐器 MusicXML，请先导出吉他声部。');
  if (['repeat','ending','segno','coda'].some(name => descendants(root,name).length) || descendants(root,'sound').some(e=>['dacapo','dalsegno','tocoda'].some(a=>e.hasAttribute(a)))) {
    reject('请将反复段落展开后再导出 MusicXML。');
  }
  const firstTabNote = descendants(parts[0], 'note').find(n => descendants(n, 'string').length && descendants(n, 'fret').length);
  if (!firstTabNote) return reject('请上传包含弦号、品位的 MusicXML 六线谱。');
  const targetStaff = text(firstTabNote, 'staff') || '1';
  const rows = children(parts[0], 'measure');
  if (!rows.length || rows.length > 80) reject('MusicXML 最多支持 80 小节。');
  let divisions = 1;
  let beatsPerMeasure = 4;
  let capo = 0;
  let tuning = [...OPEN_STRINGS];
  let tempo = 72;
  const firstTempo = descendants(root, 'sound').find(n => n.hasAttribute('tempo'))?.getAttribute('tempo');
  if (firstTempo && Number.isFinite(Number(firstTempo))) tempo = Math.max(20, Math.min(300, Number(firstTempo)));
  const measures = rows.map((measure, index): Measure => {
    const attributes = child(measure, 'attributes');
    if (attributes) {
      divisions = numeric(attributes, 'divisions', divisions);
      if (!Number.isFinite(divisions) || divisions < 0.000001 || divisions > 1000000) reject('MusicXML 时值单位无效。');
      const time = child(attributes, 'time');
      if(time) {
        const beats = numeric(time,'beats',4), type = numeric(time,'beat-type',4);
        if (!Number.isFinite(beats) || !Number.isFinite(type) || beats<=0 || type<=0) reject('当前不支持这份谱子的拍号。');
        beatsPerMeasure=beats*4/type;
        if (!Number.isFinite(beatsPerMeasure) || beatsPerMeasure <= 0 || beatsPerMeasure > 64) reject('当前不支持这份谱子的拍号。');
      }
      const details=children(attributes,'staff-details').find(e=>(e.getAttribute('number')??'1')===targetStaff);
      if(details) {
        const lines=numeric(details,'staff-lines',6);
        if(lines!==6) reject('当前支持六弦吉他谱。');
        capo=numeric(details,'capo',capo);
        if(!Number.isInteger(capo)||capo<0||capo>12) reject('变调夹位置无效。');
        const settings=children(details,'staff-tuning');
        if(settings.length) {
          if(settings.length!==6) reject('请提供完整的六弦定弦信息。');
          tuning=[...tuning];
          const seen=new Set<number>();
          for(const setting of settings) {
            const line=Number(setting.getAttribute('line'));
            const step=text(setting,'tuning-step'), octave=numeric(setting,'tuning-octave',NaN), alter=numeric(setting,'tuning-alter',0);
            if(!Number.isInteger(line)||line<1||line>6||seen.has(line)||!(step in STEPS)||!Number.isInteger(octave)||!Number.isInteger(alter)) reject('定弦信息无效。');
            seen.add(line); tuning[6-line]=(octave+1)*12+STEPS[step]+alter;
          }
        }
      }
    }
    const notes: TabNote[]=[];
    let cursor=0, lastOnset=0, maximum=0;
    for(const element of measure.children) {
      if(element.localName==='backup'||element.localName==='forward') {
        const amount=numeric(element,'duration',NaN)/divisions;
        if(!Number.isFinite(amount)||amount<0||amount>64) reject('MusicXML 时间轴无效。');
        cursor+=element.localName==='backup'?-amount:amount;
        if(!Number.isFinite(cursor)||cursor < -0.001||cursor>64) reject('MusicXML 时间轴无效。');
        cursor=Math.max(0,cursor);
        maximum=Math.max(maximum,cursor); continue;
      }
      if(element.localName!=='note') continue;
      if(child(element,'grace')) reject('当前不支持装饰音，请导出简化六线谱。');
      const duration=numeric(element,'duration',NaN)/divisions;
      if(!Number.isFinite(duration)||duration<=0||duration>64) reject('MusicXML 音符时值无效。');
      const isChord=Boolean(child(element,'chord'));
      const onset=isChord?lastOnset:cursor;
      if(!isChord) {lastOnset=cursor;cursor+=duration;}
      if(!Number.isFinite(onset+duration)||onset+duration>64) reject('MusicXML 小节时值过长。');
      maximum=Math.max(maximum,onset+duration);
      if((text(element,'staff')||'1')!==targetStaff||child(element,'rest')) continue;
      const stringText=descendants(element,'string')[0]?.textContent?.trim();
      const fretText=descendants(element,'fret')[0]?.textContent?.trim();
      if(!stringText||!fretText) reject('六线谱中有音符缺少有效弦号或品位。');
      const string=Number(stringText);
      const fret=Number(fretText);
      if(!Number.isInteger(string)||string<1||string>6||!Number.isInteger(fret)||fret<0||fret>24) reject('六线谱中有音符缺少有效弦号或品位。');
      if(descendants(element,'bend').length||descendants(element,'harmonic').length) reject('当前跟随不支持推弦或泛音标记。');
      const midi=tuning[string-1]+fret+capo;
      if(!Number.isFinite(midi)||midi<28||midi>100) reject('音符超出当前吉他音域。');
      notes.push({beat:onset,duration,string,fret,midi,tied:children(element,'tie').some(e=>e.getAttribute('type')==='stop')});
    }
    if(notes.length>64) reject('小节过密，请先简化谱面。');
    return {notes,duration:Math.max(maximum,measure.getAttribute('implicit')==='yes'?0:beatsPerMeasure),newPage:child(measure,'print')?.getAttribute('new-page')==='yes',number:measure.getAttribute('number')??String(index+1)};
  });
  const title=descendants(root,'work-title')[0]?.textContent?.trim()||text(root,'movement-title')||'吉他练习曲';
  return {title,measures,tempo};
}

function layout(measures: Measure[]): PlacedMeasure[] {
  let page=0,row=0,startBeat=0;
  return measures.map((measure,index)=>{
    if(index>0&&(row===4||measure.newPage)){page++;row=0;}
    if(page>=20) reject('MusicXML 最多支持 20 页。');
    const placed={...measure,page,row,startBeat};
    row++;startBeat+=measure.duration;return placed;
  });
}

function renderPage(rows: PlacedMeasure[], title: string, page: number, pageCount:number): ScorePage {
  const paper='#f9f7f3';
  const systems=rows.map(measure=>{
    const y=138+measure.row*112;
    const lines=Array.from({length:6},(_,s)=>`<path d="M80 ${y+s*10}H868"/>`).join('');
    const notes=measure.notes.map(n=>{
      const x=112+720*n.beat/Math.max(measure.duration,1), ny=y+(n.string-1)*10;
      return `<rect x="${x-9}" y="${ny-8}" width="18" height="16" fill="${paper}"/><text x="${x}" y="${ny+5}" text-anchor="middle" font-family="monospace" font-size="15">${n.fret}</text>`;
    }).join('');
    const beats=[...new Set(measure.notes.map(n=>n.beat))].map(beat=>{const x=112+720*beat/Math.max(measure.duration,1);return `<path d="M${x} ${y+64}v10"/>`;}).join('');
    return `<text x="58" y="${y-16}" font-size="11" fill="#777">${escape(measure.number)}</text><text x="60" y="${y+13}" font-size="12">T<tspan x="60" dy="15">A</tspan><tspan x="60" dy="15">B</tspan></text><g stroke="#8b8a81" stroke-width=".65" fill="none">${lines}<path d="M80 ${y}v50M868 ${y}v50"/>${beats}</g>${notes}`;
  }).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="920" height="620" viewBox="0 0 920 620"><rect width="920" height="620" fill="${paper}"/><g fill="#282b28" font-family="serif"><text x="460" y="52" text-anchor="middle" font-size="26">${escape(title.slice(0,48))}</text><text x="58" y="88" font-size="11">GUITAR / TAB</text>${systems}<text x="862" y="591" text-anchor="end" font-size="12">${page+1} / ${pageCount}</text></g></svg>`;
  return {id:`musicxml-${page+1}`,src:`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,width:920,height:620};
}

export function importMusicXml(xml: string, filename: string): ScoreDocument {
  const parsed=parseScore(xml);
  const measures=layout(parsed.measures);
  const count=Math.max(...measures.map(m=>m.page))+1;
  const events: ScoreEvent[]=[];
  const lastPitch=new Map<number,ScoreEvent>();
  for(const measure of measures) {
    const groups=new Map<number,TabNote[]>();
    for(const note of measure.notes) {const group=groups.get(note.beat)??[];group.push(note);groups.set(note.beat,group);}
    for(const [beat,notes] of [...groups].sort((a,b)=>a[0]-b[0])) {
      const onset=measure.startBeat+beat;
      const attacks=notes.filter(n=>!n.tied);
      for(const n of notes.filter(n=>n.tied)) {const previous=lastPitch.get(n.midi);if(previous) previous.durationBeats=Math.max(previous.durationBeats,onset+n.duration-previous.beat);}
      if(!attacks.length) continue;
      const durationBeats=Math.min(...attacks.map(n=>n.duration));
      const fraction=Math.min(0.999999,(beat+Math.min(.01,durationBeats/2))/Math.max(measure.duration,1));
      const event: ScoreEvent={
        id:`event-${events.length}`,
        midi:[...new Set(attacks.map(n=>n.midi))],beat:onset,durationBeats,
        position:measure.page+(measure.row+fraction)/4,
        // Use the same onset and row geometry as renderPage, not the biased reading fraction.
        cursor:{x:(112+720*beat/Math.max(measure.duration,1))/920,y:(128+measure.row*112)/620,height:70/620,system:measure.row},
      };
      events.push(event);for(const note of attacks)lastPitch.set(note.midi,event);
    }
  }
  if(!events.length) reject('谱子中没有可跟随的音符。');
  const reference: ScoreReference={events,initialTempo:parsed.tempo};
  const notation = createNotation([{ id: 'source-1', xml, originalPage: 0, startBeat: 0,
    durationBeats: measures.reduce((total, measure) => total + measure.duration, 0) }]);
  return {name:parsed.title||filename.replace(/\.[^.]+$/,''),kind:'musicxml',pages:Array.from({length:count},(_,i)=>renderPage(measures.filter(m=>m.page===i),parsed.title,i,count)),reference,notation};
}
