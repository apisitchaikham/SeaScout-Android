const D=require(process.argv[2]||'/home/claude/i18n/drift.js');
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  → '+JSON.stringify(x)));};
const H=3600e3,t0=Date.UTC(2026,10,22,0,0,0),lat=12.9,lon=100.8;
const north=(lat2,lon2)=>D.distM(lat,lon,lat2,lon)*(lat2>lat?1:-1), east=(lat2,lon2)=>D.distM(lat,lon,lat,lon2)*(lon2>lon?1:-1);
// 1. calm, no current, no errors: stays within GPS error
let r=D.simulate({lat,lon,acc:10,t0,t1:t0+H,cls:'piw',wind:()=>({u:0,v:0}),current:()=>({u:0,v:0}),windSd:0,curSd:0,n:2000});
ok('calm + no current: stays put (centre < 5 m)',D.distM(lat,lon,r.lat,r.lon)<5,r);
ok('calm: 90% circle ≈ GPS error (20–60 m)',r.r90>20&&r.r90<60,r.r90);
// 2. person in water, 10 m/s wind toward north, 1 h: 0.96% × 10 m/s × 3600 s = 346 m downwind
r=D.simulate({lat,lon,acc:10,t0,t1:t0+H,cls:'piw',wind:()=>({u:0,v:10}),current:()=>({u:0,v:0}),windSd:0,curSd:0,n:4000});
ok('PIW drifts 346 m downwind in 1 h at 10 m/s (±15%)',Math.abs(north(r.lat,r.lon)-346)<52,north(r.lat,r.lon));
ok('PIW sideways drift averages out (|east| < 60 m)',Math.abs(east(r.lat,r.lon))<60,east(r.lat,r.lon));
ok('PIW spread (sd 12 & 9.4 cm/s → ~400 m/h; 90% radius 550–1050 m)',r.r90>550&&r.r90<1050,r.r90);
// 3. drifting boat: mix of skiff 3.15% and fishing vessel 2.47% → ≈2.81% → ≈1012 m
r=D.simulate({lat,lon,acc:10,t0,t1:t0+H,cls:'boat',wind:()=>({u:0,v:10}),current:()=>({u:0,v:0}),windSd:0,curSd:0,n:4000});
ok('boat drifts ≈1 km downwind in 1 h (±15%)',Math.abs(north(r.lat,r.lon)-1012)<152,north(r.lat,r.lon));
// 4. current only: 0.5 m/s east for 1 h = 1800 m
r=D.simulate({lat,lon,acc:10,t0,t1:t0+H,cls:'piw',wind:()=>({u:0,v:0}),current:()=>({u:.5,v:0}),windSd:0,curSd:0,n:1000});
ok('0.5 m/s current east → 1800 m east in 1 h (±2%)',Math.abs(east(r.lat,r.lon)-1800)<36,east(r.lat,r.lon));
// 5. wind + current add up (current east 0.3, wind north 10 → PIW: 1080 m east, 346 m north)
r=D.simulate({lat,lon,acc:10,t0,t1:t0+H,cls:'piw',wind:()=>({u:0,v:10}),current:()=>({u:.3,v:0}),windSd:0,curSd:0,n:4000});
ok('wind + current combine',Math.abs(east(r.lat,r.lon)-1080)<60&&Math.abs(north(r.lat,r.lon)-346)<52,[east(r.lat,r.lon),north(r.lat,r.lon)]);
// 6. anchored boat stays even in strong wind and current
r=D.simulate({lat,lon,acc:10,t0,t1:t0+3*H,cls:'anchor',wind:()=>({u:0,v:15}),current:()=>({u:1,v:0}),n:1000});
ok('anchored: stays within ~60 m',D.distM(lat,lon,r.lat,r.lon)<10&&r.r90<80,r);
// 7. uncertainty: with model errors switched on the 90% circle is clearly wider than without
const a=D.simulate({lat,lon,acc:10,t0,t1:t0+H,cls:'piw',wind:()=>({u:0,v:8}),current:()=>({u:0,v:0}),windSd:0,curSd:0,n:2000});
const b=D.simulate({lat,lon,acc:10,t0,t1:t0+H,cls:'piw',wind:()=>({u:0,v:8}),current:()=>({u:0,v:0}),windSd:1,curSd:.2,n:2000});
ok('model-error allowance widens the circle',b.r90>a.r90*1.5,[a.r90,b.r90]);
ok('…and 0.2 m/s current error ≈ ±720 m/h: 90% radius 0.8–2 km',b.r90>800&&b.r90<2000,b.r90);
// 8. predict: helper 5 km south at 15 kn, calm → ETA ≈ 5000/7.72 s = 10.8 min, bearing ≈ 0°
const p=D.predict({kind:'piw',lat,lon,acc:10,last_at:t0},{lat:lat-5000/111320,lon,kn:15},{wind:()=>({u:0,v:0}),current:()=>({u:0,v:0}),curSd:0},t0)[0];
ok('ETA ≈ 10.8 min for 5 km at 15 kn',Math.abs((p.eta-t0)/60000-10.8)<0.6,(p.eta-t0)/60000);
ok('bearing ≈ north',p.bearing<3||p.bearing>357,p.bearing);
// 9. predict aims ahead of a target drifting away: wind pushes north at 15 m/s (boat 2.8% ≈ 0.42 m/s), helper 5 km south at 10 kn
const q=D.predict({kind:'boat_drifting',lat,lon,acc:10,last_at:t0},{lat:lat-5000/111320,lon,kn:10},{wind:()=>({u:0,v:15}),current:()=>({u:0,v:0}),curSd:0},t0)[0];
const flee=north(q.lat,q.lon),tt=(q.eta-t0)/1000;
ok('meet point is ahead of the last fix (target fled north)',flee>300,flee);
ok('meet point is consistent: helper covers 5 km + drift in the ETA',Math.abs((5000+flee)/tt-10*0.514444)<0.25,[(5000+flee)/tt,tt]);
// 10. stale fix: position from 30 min ago drifts before the helper even leaves
const s=D.predict({kind:'piw',lat,lon,acc:10,last_at:t0-30*60e3},null,{wind:()=>({u:0,v:10}),current:()=>({u:0,v:0}),curSd:0},t0)[0];
ok('a 30-min-old fix is moved ≈173 m downwind before helping',Math.abs(north(s.lat,s.lon)-173)<40,north(s.lat,s.lon));
// 11. unknown kind → three scenarios
ok('unknown kind gives person, boat and anchored scenarios',D.predict({kind:'unknown',lat,lon,acc:10,last_at:t0},null,{wind:()=>({u:0,v:5}),current:null},t0).map(x=>x.cls).join()==='piw,boat,anchor');
// 12. no wind data → flagged so the screen can warn
const nw=D.simulate({lat,lon,acc:10,t0,t1:t0+H,cls:'piw',wind:()=>null,current:()=>({u:0,v:0}),n:200});
ok('missing wind is flagged',nw.windOk===false&&nw.curOk===true);
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
