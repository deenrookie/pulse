//go:build !windows

package update

import (
	"os"
	"syscall"
	"time"
)

// RestartUnix replaces the current process image in place (same PID, ports
// rebind cleanly); the grace delay is unnecessary.
func Restart(grace time.Duration) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}
