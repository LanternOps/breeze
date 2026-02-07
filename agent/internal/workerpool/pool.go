package workerpool

import (
	"context"
	"runtime/debug"
	"sync"
	"sync/atomic"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("workerpool")

// Task is a unit of work submitted to the pool.
type Task func()

// Pool is a bounded goroutine pool with a fixed-size task queue.
type Pool struct {
	maxWorkers int
	queue      chan Task
	wg         sync.WaitGroup
	accepting  atomic.Bool
	stopOnce   sync.Once
	closeOnce  sync.Once
	stopChan   chan struct{}
}

// New creates a pool with maxWorkers goroutines and a task queue of queueSize.
func New(maxWorkers, queueSize int) *Pool {
	if maxWorkers < 1 {
		maxWorkers = 1
	}
	if queueSize < 1 {
		queueSize = 1
	}

	p := &Pool{
		maxWorkers: maxWorkers,
		queue:      make(chan Task, queueSize),
		stopChan:   make(chan struct{}),
	}
	p.accepting.Store(true)

	for i := 0; i < maxWorkers; i++ {
		go p.worker()
	}

	log.Info("worker pool started", "workers", maxWorkers, "queueSize", queueSize)
	return p
}

// Submit enqueues a task. Returns false if the pool is stopped or the queue is full.
// wg.Add is called here (before enqueue) to prevent a race with Drain.
func (p *Pool) Submit(task Task) bool {
	if !p.accepting.Load() {
		return false
	}

	p.wg.Add(1)
	select {
	case p.queue <- task:
		return true
	default:
		p.wg.Done() // undo the Add since task was not enqueued
		log.Warn("worker pool queue full, task rejected")
		return false
	}
}

// StopAccepting prevents new tasks from being submitted.
func (p *Pool) StopAccepting() {
	p.accepting.Store(false)
}

// Drain waits for all in-flight and queued tasks to complete, respecting the
// context deadline. Call StopAccepting first to prevent new submissions.
// After Drain returns, the queue channel is closed so worker goroutines exit.
func (p *Pool) Drain(ctx context.Context) {
	p.stopOnce.Do(func() {
		close(p.stopChan)
	})

	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		log.Info("worker pool drained")
	case <-ctx.Done():
		log.Warn("worker pool drain timed out")
	}

	// Close queue so worker goroutines exit and are not leaked
	p.closeOnce.Do(func() {
		close(p.queue)
	})
}

func (p *Pool) worker() {
	for {
		select {
		case task, ok := <-p.queue:
			if !ok {
				return
			}
			p.runTask(task)
		case <-p.stopChan:
			// Drain remaining queued tasks
			for {
				select {
				case task, ok := <-p.queue:
					if !ok {
						return
					}
					p.runTask(task)
				default:
					return
				}
			}
		}
	}
}

// runTask executes a single task with panic recovery. wg.Done is called here
// to match the wg.Add in Submit.
func (p *Pool) runTask(task Task) {
	defer p.wg.Done()
	defer func() {
		if r := recover(); r != nil {
			log.Error("task panicked", "panic", r, "stack", string(debug.Stack()))
		}
	}()
	task()
}
