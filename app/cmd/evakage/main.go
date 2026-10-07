package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/thesteau/evakage/app/server"
)

func main() {
	health := flag.Bool("healthcheck", false, "check the running server")
	sweep := flag.Bool("sweep-blobs", false, "remove expired relay files and exit")
	flag.Parse()
	c := server.DefaultConfig()
	if *health {
		client := http.Client{Timeout: 2 * time.Second}
		r, e := client.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", c.Port))
		if e != nil {
			os.Exit(1)
		}
		_ = r.Body.Close()
		if r.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	if *sweep {
		age := c.Blobs.MaxAgeMS
		if flag.NArg() > 0 {
			if _, e := fmt.Sscan(flag.Arg(0), &age); e != nil || age < 0 {
				fmt.Fprintln(os.Stderr, "invalid maximum age")
				os.Exit(1)
			}
		}
		result, e := server.SweepDirectory(c.Blobs.Dir, age)
		if e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
		fmt.Printf("Swept %v relayed file(s); kept %v; removed %v empty directories.\n", result["removed"], result["kept"], result["directories"])
		return
	}
	app, e := server.New(c)
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	address, e := app.Start()
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	fmt.Printf("Evakage listening on %s\n", address)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	<-signals
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e = app.Stop(ctx); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
