package heartbeat

import "time"

// startupStaggerWindow bounds each startup bulk task's random delay (W09,
// #8148, D7). The first heartbeat is already spread over one interval (and
// sent at once after a self-update), but the bulk bundle that followed it
// fired together on every agent restarted at once: an API restart or a
// promoted release turned into a burst of full inventory, hardware and patch
// uploads. Each task now waits its own U(0, 120 s), also after an update.
const startupStaggerWindow = 120 * time.Second

type startupTask struct {
	name string
	run  func()
}

// staggerStartup runs each task on its own goroutine after U(0, window),
// drawn from rnd, waiting on after. A closed stopChan cancels tasks that have
// not started. The caller keeps stamping the cadence gates when it schedules
// the bundle, so the first tick never duplicates a delayed send.
func (h *Heartbeat) staggerStartup(tasks []startupTask, window time.Duration, rnd func() float64, after func(time.Duration) <-chan time.Time) {
	for _, t := range tasks {
		d := time.Duration(rnd() * float64(window))
		log.Info("startup task delayed", "task", t.name, "delay", d.Round(time.Millisecond))
		timer := after(d) // registered here, in task order
		go func(t startupTask, timer <-chan time.Time) {
			select {
			case <-h.stopChan:
				return
			case <-timer:
			}
			select { // stop wins a tie with the timer
			case <-h.stopChan:
				return
			default:
			}
			t.run()
		}(t, timer)
	}
}
