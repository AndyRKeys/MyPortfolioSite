#!/bin/bash
# Production deploy script — runs on the Raspberry Pi
# Triggered remotely via prod-deploy.ps1 (Git Bash SSH) or directly on the Pi.
#
# Run from repo root on the Pi: bash scripts/prod-deploy.sh

ssh raspberrypi3 "bash ~/MyPortfolioSite/scripts/prod-deploy.sh"
