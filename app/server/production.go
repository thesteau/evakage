//go:build !testbridge

package server

func interceptSend(_ *socket, _ any) bool { return false }
func releaseIntercept(_ *socket)          {}
