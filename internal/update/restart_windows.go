//go:build windows

package update

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// RestartWindows spawns a detached copy of the new binary and returns; the
// caller exits right after. The child sleeps `grace` first so the parent's
// listeners are released before it binds.
func Restart(grace time.Duration) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.Env = append(os.Environ(), "PULSE_RESTART_GRACE="+grace.String())
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000200 | 0x00000008, // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
	}
	return cmd.Start()
}
