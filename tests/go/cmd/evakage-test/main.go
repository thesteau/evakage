//go:build testbridge

package main

import (
	"fmt"
	"github.com/thesteau/evakage/app/server"
	"os"
)

func main() {
	if e := server.RunTestBridge(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
