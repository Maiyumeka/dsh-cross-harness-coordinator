// Isolated clock: never replaces Date or timers in the shared test process.
export class FakeClock {
 constructor(){this.time=Date.UTC(2026,9,6);this.sequence=0;this.timers=new Map();}
 now=()=>this.time;
 setTimeout=(callback,ms=0)=>{
  const timer={id:++this.sequence,at:this.time+Math.max(0,ms),callback,unref(){return this;}};
  this.timers.set(timer.id,timer);return timer;
 };
 clearTimeout=timer=>{if(timer)this.timers.delete(timer.id);};
 pending(){return [...this.timers.values()].sort((a,b)=>a.at-b.at||a.id-b.id);}
 advanceTo(time){if(time<this.time)throw Error('clock cannot go backwards');this.time=time;}
 fire(timer){if(!this.timers.delete(timer.id))throw Error('timer is no longer pending');this.time=Math.max(this.time,timer.at);timer.callback();}
 observe(promise){
  const outcome={done:false};promise.then(value=>Object.assign(outcome,{done:true,value}),error=>Object.assign(outcome,{done:true,error}));return outcome;
 }
 async until(predicate){
  for(let turn=0;turn<100;turn++){
   // Flush streams, nextTick and Promise work without advancing virtual time.
   await new Promise(resolve=>setImmediate(resolve));if(predicate())return;
   const next=this.pending()[0];if(!next)throw Error('virtual operation stalled without a timer');this.fire(next);
  }throw Error('virtual operation did not settle');
 }
 async settle(outcome){await this.until(()=>outcome.done);if(outcome.error)throw outcome.error;return outcome.value;}
}
